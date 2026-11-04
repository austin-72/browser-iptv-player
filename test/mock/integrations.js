// Stand-ins for the subtitle sources (SubDL, Gestdown, OpenSubtitles) and a webhook receiver (tests only).
// start({ quota }) → { base, osBase, subdlBase, subdlDlBase, gestdownBase, state, close }.
const http = require('http');
const { zip } = require('../../lib/zip');

const SRT = (text) => `1\n00:00:01,000 --> 00:00:02,000\n${text}\n`;

function start(opts = {}) {
  const state = {
    subs: { subdl: [], gestdown: [], subdlOff: !!opts.subdlOff, gestdownDown: !!opts.gestdownDown },
    osDownloads: 0, osSearches: 0, osQuota: opts.quota === undefined ? 5 : opts.quota, osLogins: 0,
    hooks: [], hookFailFirst: opts.hookFailFirst || 0,
  };
  const json = (res, code, o) => { const b = JSON.stringify(o); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(b); };
  const body = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { ok({ raw: d }); } }); });
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    // ---------------- SubDL
    if (p === '/subdl/subtitles') {
      const q = Object.fromEntries(u.searchParams);
      state.subs.subdl.push(q);
      if (q.api_key !== 'sdkey') return json(res, 200, { status: false, error: 'Invalid API key' });
      if (state.subs.subdlOff) return json(res, 200, { status: false, error: "Can't find movie or tv" });
      if (q.type === 'tv') return json(res, 200, { status: true, results: [{ name: 'Show' }], subtitles: [
        { release_name: 'Show.S02E03.WEB', language: 'EN', url: '/subtitle/ep-2-3.zip', season: 2, episode: 3, hi: false },
        { release_name: 'Show.S02.Complete', language: 'EN', url: '/subtitle/season-2.zip', season: 2, episode: null, full_season: true },
      ] });
      return json(res, 200, { status: true, results: [{ name: 'Film' }], subtitles: [
        { release_name: 'Film.2020.1080p', lang: 'english', language: 'EN', url: '/subtitle/film-en.zip', hi: false },
        { release_name: 'Film.2020.FR', language: 'FR', url: '/subtitle/film-fr.zip' },
      ] });
    }
    if (p.startsWith('/subdl-dl/subtitle/')) {
      const n = p.slice('/subdl-dl/subtitle/'.length);
      state.subs.subdlDownloads = (state.subs.subdlDownloads || 0) + 1;
      const files = n === 'season-2.zip' ? [{ name: 'Show.S02E02.srt', data: SRT('Episode two') }, { name: 'Show.S02E03.srt', data: SRT('Episode three') }, { name: 'readme.txt', data: 'x' }]
        : [{ name: n.replace('.zip', '.srt'), data: SRT('SubDL ' + n) }];
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      return res.end(zip(files));
    }
    let mm;
    // ---------------- Gestdown (Addic7ed)
    if ((mm = /^\/gd\/shows\/search\/(.+)$/.exec(p))) {
      state.subs.gestdown.push(p);
      if (state.subs.gestdownDown) { res.writeHead(503); return res.end(); }
      return decodeURIComponent(mm[1]) === 'Show' ? json(res, 200, { shows: [{ id: 'show-uuid', name: 'Show', tmdbId: 4242 }] }) : json(res, 404, {});
    }
    if ((mm = /^\/gd\/subtitles\/get\/([\w-]+)\/(\d+)\/(\d+)\/(.+)$/.exec(p))) {
      state.subs.gestdown.push(p);
      if (decodeURIComponent(mm[4]) !== 'English') return json(res, 404, {});
      return json(res, 200, { matchingSubtitles: [{ subtitleId: 'g1', version: 'KILLERS', completed: true, hearingImpaired: false, hd: true, downloadUri: '/subtitles/download/g1', language: 'English', downloadCount: 321 },
        { subtitleId: 'g2', version: 'WIP', completed: false, downloadUri: '/subtitles/download/g2', language: 'English' }] });
    }
    if ((mm = /^\/gd\/subtitles\/download\/([\w-]+)$/.exec(p))) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(SRT('Addic7ed ' + mm[1]));
    }
    // ---------------- OpenSubtitles
    if (p.startsWith('/os/')) {
      if (req.headers['api-key'] !== 'oskey') return json(res, 401, { message: 'bad key' });
      if (!req.headers['user-agent']) return json(res, 400, { message: 'User-Agent required' });
      const q = p.slice(3);
      if (q === '/infos/formats') return json(res, 200, { data: { output_formats: ['srt'] } });
      if (q === '/login') { const b = await body(req); state.osLogins++; return b.username === 'me' && b.password === 'pw' ? json(res, 200, { token: 'jwt', base_url: 'api.opensubtitles.com' }) : json(res, 401, { message: 'no' }); }
      if (q === '/subtitles') {
        state.osSearches++;
        state.lastSearch = Object.fromEntries(u.searchParams);
        const mk = (id, lang, dl, extra = {}) => ({ id: String(id), attributes: { language: lang, download_count: dl, release: `Release ${id}`, hearing_impaired: false, from_trusted: false, files: [{ file_id: id, file_name: `f${id}.srt` }], ...extra } });
        return json(res, 200, { data: [mk(1, 'fr', 900), mk(2, 'en', 10), mk(3, 'en', 500), mk(4, 'en', 5000, { machine_translated: true })] });
      }
      if (q === '/download') {
        const b = await body(req);
        if (state.osQuota <= 0) return json(res, 406, { message: 'You have downloaded your allowed 5 subtitles for 24h', remaining: 0, reset_time_utc: '2030-01-01T00:00:00Z' });
        state.osQuota--;
        state.osDownloads++;
        state.lastAuth = req.headers.authorization || '';
        return json(res, 200, { link: `http://127.0.0.1:${srv.address().port}/file/${b.file_id}.srt`, remaining: state.osQuota });
      }
      return json(res, 404, {});
    }
    if (p.startsWith('/file/')) {
      res.writeHead(200, { 'Content-Type': 'application/x-subrip' });
      // Windows-1252 é and a SubStation tag, CRLF line ends.
      return res.end(Buffer.concat([Buffer.from('1\r\n00:00:01,000 --> 00:00:02,500\r\n{\\an8}Caf'), Buffer.from([0xe9]), Buffer.from('\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n<i>Two</i>\r\n')]));
    }
    // ---------------- a webhook receiver
    if (p === '/hook') {
      const raw = await new Promise((ok) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => ok(d)); });
      state.hooks.push({ headers: req.headers, body: raw });
      if (state.hookFailFirst > 0) { state.hookFailFirst--; res.writeHead(500); return res.end(); }
      res.writeHead(204); return res.end();
    }
    json(res, 404, {});
  });
  return new Promise((ok) => srv.listen(opts.port || 0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    ok({ base, osBase: base + '/os', subdlBase: base + '/subdl', subdlDlBase: base + '/subdl-dl', gestdownBase: base + '/gd', state, close: () => { srv.close(); srv.closeAllConnections(); } });
  }));
}

module.exports = { start };
if (require.main === module) start({ port: +process.argv[2] || 9641, quota: 50 }).then((m) => console.log('mock integrations on', m.base));
