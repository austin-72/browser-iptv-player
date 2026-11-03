// The front (lib/front.js): holds the port, shows "Back in a moment" while the server starts or restarts, hands over
// connections once it's ready, starts it again when it stops, and stops cleanly.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execSync } = require('child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(100); } return false; };
const get = async (base, p, accept = 'text/html') => { try { const r = await fetch(base + p, { headers: { Accept: accept } }); return { status: r.status, text: await r.text() }; } catch { return { status: 0, text: '' }; } };
const childOf = (pid) => { try { return Number(execSync(`pgrep -P ${pid}`).toString().trim().split('\n')[0]) || 0; } catch { return 0; } };

test('the front: “Back in a moment” while the server starts and restarts, then the real site; stops cleanly', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'front-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, SITE_PASSWORD: 'pw-test', MAX_MEMORY_MB: '1024' };
  delete env.NO_RESPAWN; delete env.NO_FRONT; delete env.IPTV_CHILD;
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    // The site comes up (the front may answer "Back in a moment" first).
    assert.ok(await until(async () => (await get(base, '/')).status === 200), out);
    assert.match((await get(base, '/')).text, /<html/i);
    // The server process dies: the front answers by itself and starts it again.
    const child = childOf(app.pid);
    assert.ok(child, 'the server runs as a child of the front');
    process.kill(child, 'SIGKILL');
    let sawPage = false, sawApi = false;
    assert.ok(await until(async () => {
      const r = await get(base, '/');
      if (r.status === 503 && /Back in a moment/.test(r.text)) sawPage = true;
      const a = await get(base, '/api/boot', 'application/json');
      if (a.status === 503 && /restarting/.test(a.text)) sawApi = true;
      return sawPage && r.status === 200;
    }, 30000), out);
    assert.ok(sawPage, 'pages get “Back in a moment”');
    assert.match(out, /Starting it again/);
    assert.notStrictEqual(childOf(app.pid), child, 'a new server process');
    // docker stop: the front passes it on and goes once the server has stopped.
    const exited = new Promise((ok) => app.on('exit', (code) => ok(code)));
    app.kill('SIGTERM');
    assert.strictEqual(await Promise.race([exited, wait(20000).then(() => 'timeout')]), 0);
    assert.match(out, /Shutting down/);
  } finally { try { app.kill('SIGKILL'); } catch {} }
});
