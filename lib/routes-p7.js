'use strict';
/**
 * The play queue (films and episodes lined up to play one after another), kept per profile with the rest of its data
 * and synced to the profile's other devices. Registered from server.js with one line.
 * (Clear dialogue and night mode are player settings in the profile's prefs; "Report a problem" goes through the
 * error reports in lib/errors.js.)
 */
const { apply } = require('./playqueue');

/** deps: { route, requireProfile, readJSON, HttpError, userdata, hub, catalog() } */
module.exports = function p7(deps) {
  const { route, requireProfile, readJSON, HttpError, userdata, hub } = deps;

  /** Fills in the name and type from the catalogue, and refuses what this profile isn't allowed to see. */
  const check = (prof, x) => {
    const cat = deps.catalog && deps.catalog();
    if (!cat || !x || !x.k) return x;
    const k = String(x.k);
    const it = cat.get(k);
    if (it) {
      if (!cat.visible(prof, k)) throw new HttpError(404, 'That isn’t available.');
      if (!['movie', 'show', 'episode'].includes(it.t)) throw new HttpError(400, 'Only films and series can be queued.');
      return { k, t: it.t, n: it.n, sk: it.sk || '' };
    }
    // Episodes of some series are only known once the series has been opened: check the series instead.
    if (x.sk && cat.get(String(x.sk)) && !cat.visible(prof, String(x.sk))) throw new HttpError(404, 'That isn’t available.');
    return x;
  };

  route('GET', '/api/queue', (req, res, p, q, ctx) => ({ queue: userdata.of(requireProfile(ctx).id).data.queue || [] }));
  route('POST', '/api/queue', async (req, res, p, q, ctx) => {
    const prof = requireProfile(ctx);
    const b = await readJSON(req);
    const f = userdata.of(prof.id);
    const op = { ...b };
    if (op.item) op.item = check(prof, op.item);
    const next = apply(f.data.queue, op);
    f.data.queue = next;
    f.save();
    hub.toProfile(prof.id, 'data', { field: 'queue' }, ctx.conn);
    return { queue: next };
  });
};
