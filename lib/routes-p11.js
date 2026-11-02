'use strict';
/**
 * Screen time and bedtime for profiles (enforced here, on the server), and the profile's default remote-button
 * mapping (synced with the profile's settings). Registered from server.js with one line.
 *
 * Enforcement: the playback routes refuse to start anything for a profile whose time is up (their handlers are
 * wrapped below, so the routes themselves stay as they are), a profile still watching is told to stop (and its
 * server conversions are stopped), and the minutes are counted here from what the devices already report while
 * playing: presence (what each open app is playing, including multiview tiles), the playback reports sent every
 * few seconds while the picture moves, and the server's own conversions. A profile counts once a minute however
 * many devices, tiles or parties it watches on.
 */
const { ScreenTime, localParts, serverTz, hhmm } = require('./screentime');
const { PREFS } = require('./userdata');
const { sendJSON, log } = require('./util');

// The profile's default remote and keyboard buttons (each device can have its own; see web/js/keymap.js).
if (!('remoteKeys' in PREFS)) PREFS.remoteKeys = null;

const FRESH = 90e3; // a report this recent means "still playing"

/**
 * deps: { route, routes, requireProfile, requireAdmin, readJSON, HttpError, D, accounts, hub, media, social }
 */
module.exports = function p11(deps) {
  const { route, routes, requireProfile, requireAdmin, readJSON, HttpError, D, accounts, hub, media } = deps;
  const st = new ScreenTime(D);
  const TICK = Math.max(100, Number(process.env.SCREENTIME_TICK_MS) || 15000);

  const fmtAt = (t, tz) => hhmm(localParts(t, tz).min);
  const message = (s) => {
    const again = s.nextAt ? ` You can watch again ${s.reason === 'limit' ? 'tomorrow' : 'at ' + fmtAt(s.nextAt, s.tz)}.` : '';
    if (s.reason === 'limit') return `That’s all for today.${again}`;
    if (s.reason === 'early') return `It’s a bit early for TV.${again}`;
    return `It’s past bedtime.${again}`;
  };
  const view = (s) => (s.limited ? { ...s, message: s.blocked ? message(s) : '', nextAtText: s.nextAt ? fmtAt(s.nextAt, s.tz) : '' } : s);
  const stateOf = (prof) => (!prof || prof.admin ? { limited: false } : view(st.state(prof.id)));
  const blockedFor = (ctx) => { const s = stateOf(ctx.profile); return s.limited && s.blocked ? s : null; };

  // ------------------------------------------------------------ what the devices report
  const samples = new Map(); // profile → last playback report (each device sends one every 10 s while the picture moves)
  const reports = new Map(); // profile → last "watched N seconds" report
  /** Wraps an existing route's handler (found by method and an example path). */
  const wrap = (method, example, fn) => {
    const r = routes.find((x) => x.method === method && x.re.test(example));
    if (!r) { log(`Screen time: no route for ${method} ${example}`); return; }
    const orig = r.handler;
    r.handler = (req, res, p, q, ctx) => fn(orig, req, res, p, q, ctx);
  };
  // Starting playback: refused while a profile's time is up.
  const refuse = (orig, req, res, p, q, ctx) => {
    const s = blockedFor(ctx);
    if (s) {
      // (Whatever is still playing on that device stops too.)
      const c = ctx.conn && hub.conn(ctx.conn);
      if (c && c.pid === ctx.profile.id) hub.send(c, 'screentime', { ...s, stop: true });
      return sendJSON(res, 403, { error: s.message, screentime: s });
    }
    return orig(req, res, p, q, ctx);
  };
  for (const [m, ex] of [
    ['POST', '/api/play/sources'], ['POST', '/api/play/relay'], ['POST', '/api/play/session'], ['POST', '/api/play/reach'],
    ['POST', '/api/play/external'], ['POST', '/api/party/x/stream'], ['GET', '/api/dash'], ['GET', '/api/file/x'],
    ['GET', '/api/download/x'], ['GET', '/api/mychannels/x/now'],
  ]) wrap(m, ex, refuse);
  wrap('POST', '/api/presence/stats', async (orig, req, res, p, q, ctx) => {
    const out = await orig(req, res, p, q, ctx);
    // (The route checked that the device belongs to this profile.)
    if (out && out.ok && ctx.profile) samples.set(ctx.profile.id, Date.now());
    return out;
  });
  wrap('POST', '/api/stats/watch', async (orig, req, res, p, q, ctx) => {
    const out = await orig(req, res, p, q, ctx);
    if (ctx.profile) reports.set(ctx.profile.id, Date.now());
    return out;
  });
  wrap('POST', '/api/presence', async (orig, req, res, p, q, ctx) => {
    const out = await orig(req, res, p, q, ctx);
    // Something started on a profile whose time is up (an old page, a device that didn't hear): tell it to stop.
    const s = blockedFor(ctx);
    if (s) for (const c of hub.conns) if (c.pid === ctx.profile.id && (c.playing || (c.multi && c.multi.length))) hub.send(c, 'screentime', { ...s, stop: true });
    return out;
  });

  /** Profiles watching something right now (each counted once). */
  function watchingNow(now) {
    const set = new Set();
    for (const c of hub.conns) {
      if (!c.pid) continue;
      if (c.multi && c.multi.length) { set.add(c.pid); continue; }
      const pl = c.playing;
      if (!pl) continue;
      // Just started, or the device has reported the picture moving lately (a paused player stops reporting).
      if (now - (pl.at || 0) < FRESH || now - (samples.get(c.pid) || 0) < FRESH || now - (reports.get(c.pid) || 0) < FRESH) set.add(c.pid);
    }
    // Conversions on this server: it is sending the video itself.
    for (const s of media.sessions.values()) if (s.owner && !s.exited && now - s.lastAccess < 60e3) set.add(s.owner);
    return set;
  }

  // ------------------------------------------------------------ counting, warnings and stopping
  const sent = new Map(); // pid → what the profile's devices were last told
  const sig = (s) => JSON.stringify([s.limited, s.left, s.blocked, s.reason, s.allowance, s.asked, s.bedtime, s.from, s.nextAt ? Math.round(s.nextAt / 60000) : 0]);
  function push(pid, force) {
    const prof = accounts.profile(pid);
    const s = stateOf(prof);
    const k = sig(s);
    if (!force && sent.get(pid) === k) return s;
    sent.set(pid, k);
    hub.toProfile(pid, 'screentime', s);
    return s;
  }
  function tick() {
    const now = Date.now();
    for (const [k, t] of samples) if (now - t > FRESH * 2) samples.delete(k);
    const watching = watchingNow(now);
    const limited = st.limitedIds().filter((id) => { const p = accounts.profile(id); return p && !p.admin; });
    const counted = new Set(st.tick(watching, now).filter((id) => limited.includes(id)));
    const online = new Set();
    for (const c of hub.conns) online.add(c.pid);
    for (const pid of limited) {
      if (!online.has(pid) && !counted.has(pid)) continue;
      const s = push(pid);
      if (s.blocked && watching.has(pid)) {
        // Time's up and still watching: every device of this profile stops, and so do its conversions here.
        hub.toProfile(pid, 'screentime', { ...s, stop: true });
        for (const m of [...media.sessions.values()]) if (m.owner === pid) media.stopSession(m.id);
      }
    }
    for (const pid of [...sent.keys()]) if (!online.has(pid)) sent.delete(pid);
  }
  setInterval(() => { try { tick(); } catch (e) { log('Screen time:', e && e.message); } }, TICK).unref();

  // ------------------------------------------------------------ viewers
  route('GET', '/api/screentime', (req, res, p, q, ctx) => stateOf(requireProfile(ctx)));
  route('POST', '/api/screentime/ask', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    if (prof.admin) throw new HttpError(400, 'There’s no limit to ask about.');
    const b = await readJSON(req).catch(() => ({}));
    const r = st.ask(prof.id, b.minutes, b.note);
    const admin = accounts.admin();
    // A pop-up with Give / Not today on every device the admin has open (and on the next one they open, while it waits);
    // the request also waits in Admin → Profiles.
    if (admin) hub.toProfile(admin.id, 'screentime', { ask: { id: r.id, pid: prof.id, name: prof.name, minutes: r.minutes, note: r.note } });
    return push(prof.id, true);
  });

  // ------------------------------------------------------------ the admin
  const profileOr404 = (id) => {
    const prof = accounts.profile(id);
    if (!prof) throw new HttpError(404, 'Profile not found');
    if (prof.admin) throw new HttpError(400, 'The admin profile has no screen time limits.');
    return prof;
  };
  route('GET', '/api/admin/screentime', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    for (const id of Object.keys(st.d.rules)) if (!accounts.profile(id)) st.forget(id);
    const out = {};
    for (const prof of accounts.profiles) if (!prof.admin) out[prof.id] = { ...st.adminView(prof.id), state: stateOf(prof) };
    return { tz: serverTz(), profiles: out, pending: st.pending().map((x) => ({ ...x, name: (accounts.profile(x.pid) || {}).name || '' })) };
  });
  // Requests still waiting (shown as pop-ups when the admin opens the app).
  route('GET', '/api/admin/screentime/pending', (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    return st.pending().filter((x) => accounts.profile(x.pid)).map((x) => ({ id: x.id, pid: x.pid, name: accounts.profile(x.pid).name, minutes: x.minutes, note: x.note, at: x.at }));
  });
  route('PUT', '/api/admin/screentime/:pid', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const prof = profileOr404(p.pid);
    const b = await readJSON(req);
    st.setRule(prof.id, b && b.rule ? b.rule : null);
    const s = push(prof.id, true);
    return { ...st.adminView(prof.id), state: s };
  });
  route('POST', '/api/admin/screentime/:pid/grant', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const prof = profileOr404(p.pid);
    const b = await readJSON(req);
    st.grant(prof.id, b.minutes);
    const s = push(prof.id, true);
    hub.toProfile(prof.id, 'screentime', { ...s, granted: Math.round(Number(b.minutes)) });
    return { ...st.adminView(prof.id), state: s };
  });
  route('POST', '/api/admin/screentime/:pid/reset', async (req, res, p, q, ctx) => {
    requireAdmin(ctx);
    const prof = profileOr404(p.pid);
    const b = await readJSON(req).catch(() => ({}));
    st.resetToday(prof.id, { clearUsed: !!(b && b.clearUsed) });
    const s = push(prof.id, true);
    return { ...st.adminView(prof.id), state: s };
  });
  route('POST', '/api/admin/screentime/requests/:id', async (req, res, p, q, ctx) => {
    const admin = requireAdmin(ctx);
    const b = await readJSON(req);
    const { req: r, state } = st.answer(p.id, !!b.ok, b.minutes);
    const s = push(r.pid, true);
    // (The viewer's devices say "You've got N more" or "Not today" — one note, no chat message as well.)
    hub.toProfile(r.pid, 'screentime', b.ok ? { ...s, granted: r.gave || r.minutes } : { ...s, declined: true });
    hub.toProfile(admin.id, 'screentime', { answered: r.id });
    return { request: r, state: view(state) };
  });

  return { screenTime: st, watchingNow, tick };
};
