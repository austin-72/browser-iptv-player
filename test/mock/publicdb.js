// A local stand-in for the public guide/logo databases (iptv-org's API, epg.pw's XMLTV files) and for a small
// provider with live channels that work and ones that don't (channel health checks). Used by test/p9.test.js;
// `node test/mock/publicdb.js 9599` runs it on its own for trying the UI.
const http = require('http');
const zlib = require('zlib');

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function data(base) {
  const channels = [
    { id: 'HarbourOne.uk', name: 'Harbour One', alt_names: ['Harbour 1'], network: null, owners: [], country: 'UK', categories: ['general'], is_nsfw: false, launched: null, closed: null, replaced_by: null, website: null },
    { id: 'HarbourOne.us', name: 'Harbour One', alt_names: [], network: null, owners: [], country: 'US', categories: ['general'], is_nsfw: false, launched: null, closed: null, replaced_by: null, website: null },
    { id: 'MeadowTV.uk', name: 'Meadow TV', alt_names: ['Meadow Television'], network: null, owners: [], country: 'UK', categories: ['kids'], is_nsfw: false, launched: null, closed: null, replaced_by: null, website: null },
    { id: 'CopperNews.us', name: 'Copper News', alt_names: [], network: null, owners: [], country: 'US', categories: ['news'], is_nsfw: false, launched: null, closed: null, replaced_by: null, website: null },
    { id: 'LanternSport.de', name: 'Lantern Sport', alt_names: [], network: null, owners: [], country: 'DE', categories: ['sports'], is_nsfw: false, launched: null, closed: null, replaced_by: null, website: null },
  ];
  // (Lots of others, so the reader has to stream through a big file.)
  for (let i = 0; i < 3000; i++) channels.push({ id: `Filler${i}.fr`, name: `Filler Channel ${i}`, alt_names: [`Fill ${i}`], network: null, owners: [], country: 'FR', categories: [], is_nsfw: false, launched: null, closed: null, replaced_by: null, website: 'https://example.com/{"x":"]"}' });
  const logos = [
    { channel: 'HarbourOne.uk', feed: null, tags: [], width: 512, height: 512, format: 'SVG', url: `${base}/logos/harbour.svg`, in_use: true },
    { channel: 'HarbourOne.uk', feed: null, tags: [], width: 512, height: 512, format: 'PNG', url: `${base}/logos/harbour.png`, in_use: true },
    { channel: 'MeadowTV.uk', feed: 'HD', tags: [], width: 300, height: 300, format: 'PNG', url: `${base}/logos/meadow-hd.png`, in_use: true },
    { channel: 'MeadowTV.uk', feed: null, tags: [], width: 300, height: 300, format: 'PNG', url: `${base}/logos/meadow.png`, in_use: true },
    { channel: 'CopperNews.us', feed: null, tags: [], width: 300, height: 300, format: 'PNG', url: `${base}/logos/copper.png`, in_use: true },
  ];
  const guides = [
    { channel: 'HarbourOne.uk', feed: null, site: 'tvguide.example', site_id: 'h1', site_name: 'Harbour One', lang: 'en', sources: [] },
    { channel: null, feed: null, site: 'other.example', site_id: 'x', site_name: 'X', lang: 'en', sources: [] },
    { channel: 'LanternSport.de', feed: null, site: 'tv.example', site_id: 'ls', site_name: 'Lantern Sport', lang: 'de', sources: [] },
  ];
  return { channels, logos, guides };
}

function xmltv(cc) {
  const t = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}0000 +0000`; };
  const now = new Date(); now.setUTCMinutes(0, 0, 0);
  const chans = cc === 'GB' ? [['4401', 'Harbour One'], ['4402', '[SkyTV] Meadow TV'], ['4403', 'Coastal Radio']] : cc === 'US' ? [['5501', 'Copper News'], ['5502', 'Harbour One']] : [];
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="mock">\n';
  for (const [id, n] of chans) x += `<channel id="${id}"><display-name lang="${cc}">${n.replace(/&/g, '&amp;')}</display-name><icon src="http://logos.example/${id}.png"/></channel>\n`;
  for (const [id, n] of chans) for (let h = -2; h < 24; h++) {
    const s = new Date(now.getTime() + h * 3600e3), e = new Date(s.getTime() + 3600e3);
    x += `<programme start="${t(s)}" stop="${t(e)}" channel="${id}"><title>${n} programme ${h}</title></programme>\n`;
  }
  return x + '</tv>\n';
}

function start(port = 0) {
  const hits = { list: [] };
  let base = '';
  let D = null;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    hits.list.push(p);
    hits[p] = (hits[p] || 0) + 1;
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' }); res.end(body); };
    // iptv-org API (sent in small pieces, like a big download)
    const m = /^\/api\/(channels|logos|guides)\.json$/.exec(p);
    if (m) {
      const s = JSON.stringify(D[m[1]]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      let i = 0;
      const step = () => { if (i >= s.length) return res.end(); res.write(s.slice(i, i + 7001)); i += 7001; setImmediate(step); };
      return step();
    }
    const x = /^\/xmltv\/epg_([A-Z]{2})\.xml\.gz$/.exec(p);
    if (x) { if (!['GB', 'US'].includes(x[1])) return send(404, 'text/plain', 'no'); return send(200, 'application/gzip', zlib.gzipSync(xmltv(x[1]))); }
    if (/^\/logos\//.test(p)) return send(200, /svg/.test(p) ? 'image/svg+xml' : 'image/png', /svg/.test(p) ? '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' : PNG);
    // A small provider: a playlist and live streams.
    if (p === '/playlist.m3u') {
      const L = [
        '#EXTM3U',
        `#EXTINF:-1 tvg-id="" group-title="UK | Entertainment",Harbour One HD\n${base}/live/ok.m3u8`,
        `#EXTINF:-1 group-title="UK | Kids" tvg-logo="",Meadow TV\n${base}/live/dead.m3u8`,
        `#EXTINF:-1 tvg-id="CopperNews.us" group-title="News",Copper News\n${base}/ts/ok.ts`,
        `#EXTINF:-1 group-title="DE | Sport",Lantern Sport\n${base}/ts/text`,
        `#EXTINF:-1 group-title="Other",Unknown Thing\n${base}/ts/gone`,
      ];
      return send(200, 'audio/x-mpegurl', L.join('\n') + '\n');
    }
    if (p === '/playlist2.m3u') return send(200, 'audio/x-mpegurl', `#EXTM3U\n#EXTINF:-1 group-title="UK | Kids",Meadow TV\n${base}/live/ok.m3u8?b=2\n`);
    if (p === '/live/ok.m3u8') return send(200, 'application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nok-lo.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nok-hi.m3u8\n');
    if (p === '/live/ok-lo.m3u8' || p === '/live/ok-hi.m3u8') return send(200, 'application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:4,\n/seg/7.ts\n#EXTINF:4,\n/seg/8.ts\n');
    if (/^\/seg\/\d+\.ts$/.test(p)) { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); res.write(Buffer.alloc(188 * 50, 0x47)); hits.segOpen = (hits.segOpen || 0) + 1; return setTimeout(() => res.end(), 50); }
    if (p === '/ts/ok.ts') {
      // An endless stream: the check must take a few KB and hang up.
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      hits.tsOpen = (hits.tsOpen || 0) + 1;
      const t = setInterval(() => res.write(Buffer.alloc(1880, 0x47)), 20);
      res.on('close', () => { clearInterval(t); hits.tsClosed = (hits.tsClosed || 0) + 1; });
      return;
    }
    if (p === '/ts/text') return send(200, 'text/plain', 'Stream not available');
    return send(404, 'text/plain', 'not found');
  });
  return new Promise((ok) => srv.listen(port, '127.0.0.1', () => {
    base = `http://127.0.0.1:${srv.address().port}`;
    D = data(base);
    ok({ base, iptvBase: `${base}/api`, epgpwBase: base, hits, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) });
  }));
}

module.exports = { start };
if (require.main === module) start(Number(process.argv[2]) || 9599).then((m) => console.log('mock public db on', m.base));
