'use strict';
/**
 * The front: a tiny process that holds the web port and starts the real server as a child process.
 *
 * - While the server is starting or restarting (a big catalogue can take a minute), the front answers by itself: web
 *   pages get a "Back in a moment" page that reloads on its own when the server is back; the app's own requests get
 *   "503, restarting" (the app already waits and tries again on that). Before, the site simply didn't answer.
 * - Once the server is ready, every new connection is handed to it whole (the front never reads or copies any of it),
 *   so video and pages go exactly as fast as before.
 * - When the server stops by itself (an update, a restored backup, a crash) the front starts it again at once,
 *   without the whole container having to restart. Stop signals (docker stop) are passed on and waited for.
 * - It also starts the server with enough memory (see server.js).
 *
 * NO_RESPAWN=1 (or NO_FRONT=1) runs the server directly, without the front.
 */
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const log = (...a) => console.log(`[${stamp()}] [front]`, ...a);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** opts: { script, args, execArgv, port, host, tls: { cert, key } | null, dataDir } */
function startFront({ script, args = [], execArgv = [], port, host, tls = null, dataDir }) {
  let child = null;
  let ready = false;
  let stopping = false;
  let startedAt = 0;
  let quickFails = 0;
  let restartTimer = null;
  let since = Date.now(); // when the site went away (for the page)

  const brand = () => { try { const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')); return (s.brand && s.brand.name) || ''; } catch { return ''; } };

  // ------------------------------------------------------------ the "back in a moment" answers
  const page = (name) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name || 'Restarting')} — back in a moment</title><meta name="color-scheme" content="dark light">
<style>
:root{--bg:#0b0c10;--fg:#f2f3f5;--dim:#a0a4ad;--accent:#e50914}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--fg:#15171c;--dim:#5b616c}}
html,body{height:100%;margin:0}body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;text-align:center;padding:16px;box-sizing:border-box}
main{max-width:28rem}h1{font-size:1.6rem;margin:.9rem 0 .3rem}p{color:var(--dim);margin:.3rem 0}
.spin{width:44px;height:44px;margin:0 auto;border-radius:50%;border:4px solid color-mix(in srgb,var(--fg) 15%,transparent);border-top-color:var(--accent);animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}@media (prefers-reduced-motion: reduce){.spin{animation-duration:3s}}
.brand{font-weight:800;color:var(--accent);letter-spacing:.01em}
</style></head><body><main>
${name ? `<div class="brand">${esc(name)}</div>` : ''}<div class="spin" role="progressbar" aria-label="Waiting for the server"></div>
<h1>Back in a moment</h1><p>The server is restarting. This page carries on by itself as soon as it's ready.</p><p class="t" aria-live="polite"></p>
</main><script>
var t0=Date.now(),el=document.querySelector('.t');
function tick(){var s=Math.round((Date.now()-t0)/1000);el.textContent=s>20?'Still starting — a big catalogue can take a minute or two.':'';
fetch('/__front?'+Date.now(),{cache:'no-store'}).then(function(r){if(r.status!==503)location.reload();else setTimeout(tick,2000)},function(){setTimeout(tick,3000)})}
setTimeout(tick,1500);
</script></body></html>`;
  const answer = (req, res) => {
    const url = req.url || '/';
    const h = { 'Retry-After': '5', 'Cache-Control': 'no-store', Connection: 'close' };
    if (url.startsWith('/__front')) { res.writeHead(503, { ...h, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ready: false, since })); }
    // The app's own requests (and anything that isn't a page): a short "restarting" the app knows to wait on.
    const wantsPage = req.method === 'GET' && !url.startsWith('/api/') && /text\/html/.test(req.headers.accept || '');
    if (!wantsPage) { res.writeHead(503, { ...h, 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'The server is restarting — back in a moment.', restarting: true })); }
    res.writeHead(503, { ...h, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(brand()));
  };
  const maint = tls ? https.createServer(tls, answer) : http.createServer(answer);
  maint.keepAliveTimeout = 1000;

  // ------------------------------------------------------------ the port
  const front = net.createServer({ pauseOnConnect: true }, (socket) => {
    socket.on('error', () => {});
    const local = () => { maint.emit('connection', socket); socket.resume(); };
    if (!ready || !child || !child.connected) return local();
    try { child.send('conn', socket, (err) => { if (err) { try { local(); } catch { socket.destroy(); } } }); } catch { local(); }
  });
  front.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Start with --port 8081 (or set PORT).`);
    else console.error(e);
    process.exit(1);
  });
  front.listen(port, host);

  // ------------------------------------------------------------ the server itself
  const start = () => {
    restartTimer = null;
    ready = false;
    startedAt = Date.now();
    child = spawn(process.execPath, [...execArgv, script, ...args], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: { ...process.env, IPTV_CHILD: '1', IPTV_FRONT: '1' } });
    child.on('message', (m) => {
      if (m && m.ready) { ready = true; quickFails = 0; log(`The server is answering (${((Date.now() - since) / 1000).toFixed(0)} s after the site went away).`); }
    });
    child.on('exit', (code, sig) => {
      ready = false;
      child = null;
      since = Date.now();
      if (stopping) return process.exit(code === null ? 0 : code);
      // Again and again straight after starting: wait longer each time (up to a minute) instead of spinning.
      quickFails = Date.now() - startedAt < 60e3 ? quickFails + 1 : 0;
      const wait = quickFails > 1 ? Math.min(60e3, 2000 * 2 ** (quickFails - 2)) : 500;
      log(`The server stopped (${sig || 'exit code ' + code}). Starting it again${wait > 1000 ? ` in ${Math.round(wait / 1000)} s` : ''} — visitors see “Back in a moment” meanwhile.`);
      restartTimer = setTimeout(start, wait);
    });
  };
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(restartTimer);
    front.close();
    if (!child) return process.exit(0);
    try { child.kill(sig); } catch {}
    // (Should it not stop within 25 s, go anyway: Docker kills everything soon after.)
    setTimeout(() => { try { child && child.kill('SIGKILL'); } catch {} process.exit(0); }, 25000).unref();
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stop(sig));
  start();
  return { front, maint, isReady: () => ready };
}

/** In the server (the child): take the connections the front hands over, and say when it's ready for them. */
function attachToFront(server) {
  if (!process.env.IPTV_FRONT || typeof process.send !== 'function') return false;
  process.on('message', (m, socket) => {
    if (m !== 'conn' || !socket) return;
    server.emit('connection', socket);
    socket.resume();
  });
  // (The front going away — it was stopped hard — means this should go too.)
  process.on('disconnect', () => process.exit(0));
  return true;
}
function tellFrontReady() { try { if (process.send) process.send({ ready: true }); } catch {} }

module.exports = { startFront, attachToFront, tellFrontReady };
