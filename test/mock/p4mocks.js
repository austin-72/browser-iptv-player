// Stand-ins for tests: a Stalker/Ministra portal, a Jellyfin server and a Plex server. All on 127.0.0.1.
const http = require('http');

const listen = (srv, port = 0) => new Promise((ok) => srv.listen(port, '127.0.0.1', () => ok(`http://127.0.0.1:${srv.address().port}`)));
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

/** A Stalker portal at /stalker_portal/server/load.php (the panel's /c/ page is what people paste). */
async function stalkerPortal({ mac = '00:1A:79:00:00:01', port = 0, streamFile = '' } = {}) {
  const st = { tokens: new Set(), handshakes: 0, links: [], expireNext: false, seen: [] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    st.seen.push(u.pathname + '?' + u.searchParams.get('action'));
    if (/^\/stream\//.test(u.pathname)) {
      if (streamFile) { res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Access-Control-Allow-Origin': '*' }); return require('fs').createReadStream(streamFile).pipe(res); }
      res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(Buffer.alloc(188 * 10, 0x47));
    }
    if (u.pathname !== '/stalker_portal/server/load.php') { res.writeHead(404); return res.end('not here'); }
    const cookie = req.headers.cookie || '';
    if (!cookie.includes(`mac=${encodeURIComponent(mac)}`)) return json(res, 200, { js: { status: 1, msg: 'Unknown MAC' } });
    const q = u.searchParams;
    const type = q.get('type'), action = q.get('action');
    if (type === 'stb' && action === 'handshake') { const t = 'T' + (++st.handshakes); st.tokens.add(t); return json(res, 200, { js: { token: t } }); }
    const tok = (req.headers.authorization || '').replace('Bearer ', '');
    if (!st.tokens.has(tok)) { res.writeHead(401); return res.end('Authorization failed.'); }
    if (st.expireNext) { st.expireNext = false; st.tokens.clear(); res.writeHead(401); return res.end('Authorization failed.'); }
    if (type === 'stb' && action === 'get_profile') return json(res, 200, { js: { id: 1, name: 'box', status: 0 } });
    if (type === 'account_info') return json(res, 200, { js: { mac, phone: '', end_date: '2030-01-31 00:00:00' } });
    if (type === 'itv' && action === 'get_genres') return json(res, 200, { js: [{ id: '*', title: 'All' }, { id: '10', title: 'News' }, { id: '11', title: 'Sport' }] });
    if (type === 'itv' && action === 'get_all_channels') return json(res, 200, { js: { data: [
      { id: '1', name: 'Portal News', number: '1', cmd: 'ffrt http://localhost/ch/1_', logo: 'http://img.example/n.png', tv_genre_id: '10', xmltv_id: '' },
      { id: '2', name: 'Portal Sport', number: '2', cmd: 'ffmpeg http://127.0.0.1/stream/live/2.ts', logo: '/stalker_portal/misc/logos/2.png', tv_genre_id: '11', xmltv_id: 'sport.example' },
    ] } });
    if (type === 'itv' && action === 'create_link') {
      st.links.push(q.get('cmd'));
      const host = `127.0.0.1:${srv.address().port}`;
      return json(res, 200, { js: { cmd: `ffmpeg http://${host}/stream/live/${q.get('cmd').includes('ch/1') ? 1 : 2}.ts?play_token=abc` } });
    }
    if (type === 'itv' && action === 'get_epg_info') {
      const now = Math.floor(Date.now() / 1000);
      return json(res, 200, { js: { data: { 1: [{ name: 'Morning News', descr: 'Headlines', start_timestamp: now - 1800, stop_timestamp: now + 1800 }, { name: 'Weather', start_timestamp: now + 1800, stop_timestamp: now + 3600 }] } } });
    }
    if ((type === 'vod' || type === 'series') && action === 'get_categories') return json(res, 200, { js: type === 'vod' ? [{ id: '*', title: 'All' }, { id: '5', title: 'Action' }] : [{ id: '7', title: 'Drama series' }] });
    if (type === 'vod' && action === 'get_ordered_list' && !q.get('movie_id')) {
      const page = Number(q.get('p'));
      const all = Array.from({ length: 20 }, (_, i) => ({ id: String(100 + i), name: `Portal Film ${i + 1}`, description: 'A film.', year: '2020', rating_imdb: '7.1', screenshot_uri: `http://img.example/f${i}.jpg`, cmd: `/media/${100 + i}.mpg`, time: '95', is_series: 0 }));
      return json(res, 200, { js: { total_items: 20, max_page_items: 14, cur_page: page, data: all.slice((page - 1) * 14, page * 14) } });
    }
    if (type === 'series' && action === 'get_ordered_list' && !q.get('movie_id')) return json(res, 200, { js: { total_items: 1, max_page_items: 14, data: [{ id: '900', name: 'Portal Series', description: 'A series.', year: '2021', cmd: '', is_series: 1 }] } });
    if (type === 'series' && action === 'get_ordered_list' && q.get('movie_id') === '900') {
      return json(res, 200, { js: { data: [{ id: '900:1', name: 'Season 1', series: [1, 2, 3], cmd: 'eyJzZWFzb24iOjF9', is_season: true }, { id: '900:2', name: 'Season 2', series: [1], cmd: 'eyJzZWFzb24iOjJ9' }] } });
    }
    if (type === 'vod' && action === 'create_link') {
      st.links.push(q.get('cmd') + '#' + q.get('series'));
      return json(res, 200, { js: { cmd: `ffmpeg http://127.0.0.1:${srv.address().port}/stream/vod/${encodeURIComponent(q.get('cmd'))}-${q.get('series') || 0}.mp4` } });
    }
    return json(res, 200, { js: [] });
  });
  const base = await listen(srv, port);
  return { srv, base, st, portal: base + '/stalker_portal/c/' };
}

/** A Jellyfin server: username/password sign-in, two films and a series with episodes, one Live TV channel. */
async function jellyfin({ port = 0 } = {}) {
  const st = { auth: 0 };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const tok = req.headers['x-emby-token'] || u.searchParams.get('api_key');
    if (u.pathname === '/Users/AuthenticateByName' && req.method === 'POST') {
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { const j = JSON.parse(b); st.auth++; if (j.Username === 'tv' && j.Pw === 'secret') json(res, 200, { AccessToken: 'JT', User: { Id: 'U1' } }); else { res.writeHead(401); res.end(); } });
      return;
    }
    if (tok !== 'JT') { res.writeHead(401); return res.end(); }
    if (u.pathname === '/Users/U1/Items') {
      const items = [
        { Id: 'm1', Type: 'Movie', Name: 'Lake House Rules', ProductionYear: 2022, Overview: 'Five friends.', CommunityRating: 6.8, OfficialRating: 'PG-13', Genres: ['Comedy'], RunTimeTicks: 60600000000, ProviderIds: { Tmdb: '42' }, Container: 'mkv', ImageTags: { Primary: 'p1' }, BackdropImageTags: ['b1'], People: [{ Name: 'Ada Alves', Type: 'Actor' }, { Name: 'Kai Sato', Type: 'Director' }] },
        { Id: 'm2', Type: 'Movie', Name: 'Glass Harbor', ProductionYear: 2025, Container: 'mp4', ImageTags: {} },
        { Id: 's1', Type: 'Series', Name: 'Copper Creek', ProductionYear: 2021, Overview: 'A town.', ImageTags: { Primary: 'p3' } },
      ];
      const start = Number(u.searchParams.get('StartIndex')) || 0;
      return json(res, 200, { Items: items.slice(start), TotalRecordCount: items.length });
    }
    if (u.pathname === '/Shows/s1/Episodes') return json(res, 200, { Items: [{ Id: 'e1', Name: 'The Last Shift', ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 28800000000, Container: 'mkv', Overview: 'Pilot.' }, { Id: 'e2', Name: 'Town Meeting', ParentIndexNumber: 1, IndexNumber: 2, Container: 'mp4' }] });
    if (u.pathname === '/LiveTv/Channels') return json(res, 200, { Items: [{ Id: 'c1', Name: 'Antenna One', ChannelNumber: '5.1', ImageTags: { Primary: 'cl' }, ChannelType: 'TV' }] });
    res.writeHead(404); res.end();
  });
  const base = await listen(srv, port);
  return { srv, base, st };
}

/** A Plex server with a film section and a TV section. */
async function plex() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.headers['x-plex-token'] !== 'PT') { res.writeHead(401); return res.end(); }
    if (u.pathname === '/library/sections') return json(res, 200, { MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Films' }, { key: '2', type: 'show', title: 'TV Shows' }, { key: '3', type: 'artist', title: 'Music' }] } });
    if (u.pathname === '/library/sections/1/all') return json(res, 200, { MediaContainer: { totalSize: 1, Metadata: [{ ratingKey: '10', title: 'Red Horizon', year: 2023, summary: 'Desert.', audienceRating: 7, contentRating: 'PG-13', duration: 6540000, thumb: '/library/metadata/10/thumb/1', art: '/library/metadata/10/art/1', Genre: [{ tag: 'Action' }], Guid: [{ id: 'tmdb://77' }], Media: [{ container: 'mp4', Part: [{ key: '/library/parts/55/123/file.mp4', container: 'mp4' }] }] }] } });
    if (u.pathname === '/library/sections/2/all') return json(res, 200, { MediaContainer: { totalSize: 1, Metadata: [{ ratingKey: '20', title: 'Harbor Lights', year: 2022, summary: 'Crime.', thumb: '/library/metadata/20/thumb/1' }] } });
    if (u.pathname === '/library/metadata/20/allLeaves') return json(res, 200, { MediaContainer: { Metadata: [{ ratingKey: '21', title: 'Low Tide', index: 1, parentIndex: 1, duration: 2880000, Media: [{ Part: [{ key: '/library/parts/66/1/file.mkv' }] }] }] } });
    res.writeHead(404); res.end();
  });
  const base = await listen(srv);
  return { srv, base };
}

module.exports = { stalkerPortal, jellyfin, plex };
