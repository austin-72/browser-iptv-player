'use strict';
// The sign-in page (web/login.js): once the password is right, the app opens — also when the address already ends in
// a page (#/home), where location.replace() to the same address only moves to that spot and loads nothing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'login.js'), 'utf8');

function signIn(href) {
  const u = new URL(href);
  const did = [];
  const el = () => ({ onclick: null, onsubmit: null, classList: { toggle() {}, contains() { return false; } }, setAttribute() {}, focus() {}, select() {}, textContent: '', innerHTML: '', value: 'pw', type: 'password', disabled: false });
  const els = {};
  const document = { getElementById: (id) => (els[id] = els[id] || el()), documentElement: { className: '' } };
  const location = { pathname: u.pathname, search: u.search, hash: u.hash, reload: () => did.push('reload'), replace: (to) => did.push('replace ' + to) };
  const fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  vm.runInNewContext(SRC, { window: { fetch, Promise }, fetch, Promise, document, location, navigator: { userAgent: 'Chrome' }, sessionStorage: { getItem() { return ''; }, setItem() {} }, setTimeout, clearTimeout, setInterval, clearInterval, JSON, encodeURIComponent });
  els.f.onsubmit({ preventDefault() {} });
  return new Promise((ok) => setTimeout(() => ok(did), 20));
}

test('signed in: the app opens, whatever page the address was at', async () => {
  assert.deepStrictEqual(await signIn('http://tv.example/'), ['reload']);
  assert.deepStrictEqual(await signIn('http://tv.example/#/home'), ['reload'], 'the same address with a page: loaded again, not just moved to');
  assert.deepStrictEqual(await signIn('http://tv.example/#/title/abc'), ['reload'], 'and it stays at that page');
  assert.deepStrictEqual(await signIn('http://tv.example/?signin=1#/home'), ['replace /#/home']);
  assert.deepStrictEqual(await signIn('http://tv.example/c/xyz'), ['replace /']);
});
