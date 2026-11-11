'use strict';
// The TV app wrappers in tv-apps/ (Android TV / Fire TV, Samsung, LG): thin, in step with each other and with the
// pages they open. (None of this is a TV: it checks what can be checked from here.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const T = path.join(__dirname, '..', 'tv-apps');
const read = (...p) => fs.readFileSync(path.join(T, ...p), 'utf8');

test('Samsung and LG: the same page that asks for the address, each with its own description of the app', () => {
  for (const f of ['index.html', 'app.css', 'app.js']) assert.strictEqual(read('tizen', f), read('webos', f), `${f} is the same in both`);
  const info = JSON.parse(read('webos', 'appinfo.json'));
  assert.deepStrictEqual([info.type, info.main, info.disableBackHistoryAPI], ['web', 'index.html', true]);
  for (const f of [info.icon, info.largeIcon, 'index.html']) assert.ok(fs.existsSync(path.join(T, 'webos', f)), f);
  const cfg = read('tizen', 'config.xml');
  assert.match(cfg, /<content src="index\.html"\/>/);
  assert.match(cfg, /<tizen:allow-navigation>\*<\/tizen:allow-navigation>/, 'the server’s pages open inside the app');
  assert.match(cfg, /privilege\/tv\.inputdevice/, 'the remote’s coloured and media buttons');
  assert.ok(fs.existsSync(path.join(T, 'tizen', 'icon.png')));
  // (Old TVs: nothing newer than ES5 in the page's script.)
  const js = read('tizen', 'app.js');
  assert.ok(!/=>|\blet\b|\bconst\b|`/.test(js.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'plain ES5');
  assert.doesNotThrow(() => new vm.Script(js));
});

test('the address page: tidies what was typed, opens only what answers, and Up changes the address', async () => {
  // A stand-in for the TV's page: just enough of a document to run the script.
  const el = () => ({ hidden: false, value: '', textContent: '', focus() {}, selectionStart: 0 });
  const els = { ask: el(), wait: el(), addr: el(), err: el(), go: el(), where: el() };
  els.ask.hidden = true; els.wait.hidden = true;
  const store = {};
  const keys = [];
  let opened = '', answers = true;
  const timers = [];
  const ctx = {
    document: { getElementById: (id) => els[id], addEventListener: (n, fn) => keys.push(fn), activeElement: null },
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    location: { replace: (u) => { opened = u; } },
    Image: function () { const self = this; Object.defineProperty(this, 'src', { set(v) { self._src = v; setTimeout(() => (answers ? self.onload() : self.onerror()), 0); } }); },
    setTimeout: (fn, ms) => { if (ms >= 3000) { timers.push(fn); return 0; } return setTimeout(fn, 0); }, clearTimeout: () => {}, Date, window: {},
  };
  const run = () => vm.runInNewContext(read('tizen', 'app.js'), ctx);
  const tick = () => new Promise((r) => setTimeout(r, 10));
  run();
  assert.strictEqual(els.ask.hidden, false, 'the first time: it asks');
  els.addr.value = 'nonsense here'; els.go.onclick();
  assert.match(els.err.textContent, /doesn’t look like an address/);
  answers = false; els.addr.value = '192.168.1.20:8080/'; els.go.onclick(); await tick();
  assert.match(els.err.textContent, /Nothing answered at http:\/\/192\.168\.1\.20:8080/);
  assert.strictEqual(opened, '');
  answers = true; els.go.onclick(); await tick();
  assert.strictEqual(opened, 'http://192.168.1.20:8080/');
  assert.strictEqual(store.server, 'http://192.168.1.20:8080', 'remembered once it answered');
  // Next time: "Opening…", and Up within the three seconds asks again instead.
  opened = ''; els.ask.hidden = true; els.wait.hidden = true; keys.length = 0; timers.length = 0; els.addr.value = '';
  run();
  assert.strictEqual(els.wait.hidden, false);
  assert.strictEqual(els.where.textContent, '192.168.1.20:8080');
  keys[0]({ keyCode: 38, preventDefault() {} });
  assert.deepStrictEqual([els.ask.hidden, els.wait.hidden, els.addr.value], [false, true, 'http://192.168.1.20:8080']);
  // Left alone, it opens.
  els.ask.hidden = true; els.wait.hidden = true; keys.length = 0; timers.length = 0; els.addr.value = '';
  run(); timers[0](); await tick();
  assert.strictEqual(opened, 'http://192.168.1.20:8080/');
});

test('Android TV: what the pages ask of the app is there, and Back goes to the pages', () => {
  const java = read('android', 'app', 'src', 'main', 'java', 'org', 'superstation', 'tv', 'MainActivity.java');
  const tv = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'tv.js'), 'utf8');
  // The bridge the pages look for (web/js/tv.js: V.inTvApp, V.leaveApp).
  assert.match(java, /addJavascriptInterface\(new Bridge\(\), "TvApp"\)/);
  assert.match(java, /@JavascriptInterface\s+public void exit\(\)/);
  assert.match(tv, /window\.TvApp\.exit\(\)/);
  assert.match(tv, /tizen\.application\.getCurrentApplication\(\)\.exit\(\)/);
  assert.match(tv, /PalmSystem\.platformBack\(\)/);
  // Back is handed to the pages as the key they already listen for.
  assert.match(java, /e\.keyCode=10009/);
  assert.match(tv, /e\.keyCode === 10009/);
  // (Every brace closed: nobody compiled this here.)
  const count = (re) => (java.match(re) || []).length;
  assert.strictEqual(count(/\{/g), count(/\}/g));
  assert.strictEqual(count(/\(/g), count(/\)/g));
  const man = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');
  assert.match(man, /android\.intent\.category\.LEANBACK_LAUNCHER/);
  assert.match(man, /android:banner="@drawable\/banner"/);
  for (const f of [['res', 'drawable-xhdpi', 'banner.png'], ['res', 'mipmap-xxxhdpi', 'ic_launcher.png'], ['res', 'values', 'strings.xml']]) assert.ok(fs.existsSync(path.join(T, 'android', 'app', 'src', 'main', ...f)), f.join('/'));
  for (const name of (java.match(/(?<!android\.)R\.string\.(\w+)/g) || []).map((x) => x.slice(9))) assert.match(read('android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), new RegExp(`name="${name}"`), name);
});
