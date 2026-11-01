'use strict';
/* Server-side playlist parsing. Reuses the browser parser (lib/shared/m3u.js) in a sandbox with a tiny
   DOMParser stand-in, so M3U/PLS/XSPF/ASX/JSON/URL lists are read exactly the same way everywhere. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- minimal XML DOM: enough for XSPF and ASX (querySelector by tag name, ':scope > tag', textContent, getAttribute)
function parseXmlDom(text) {
  const root = { nodeName: '#document', children: [], parent: null, attrs: {}, text: '' };
  let cur = root;
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)([^>]*?)(\/?)>|([^<]+)/gi;
  let m;
  const dec = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (x, e) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'amp') return '&'; if (k === 'quot') return '"'; if (k === 'apos') return "'";
    return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });
  let bad = false;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) { cur.text += m[1]; continue; }
    if (m[2]) {
      const name = m[2].toLowerCase();
      let n = cur;
      while (n && n.nodeName !== name) n = n.parent;
      if (n && n.parent) cur = n.parent; else bad = true;
      continue;
    }
    if (m[3]) {
      const attrs = {};
      const ar = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4] || ''))) attrs[a[1].toLowerCase()] = dec(a[3] !== undefined ? a[3] : a[4]);
      const el = { nodeName: m[3].toLowerCase(), children: [], parent: cur, attrs, text: '' };
      cur.children.push(el);
      if (!m[5]) cur = el;
      continue;
    }
    if (m[6]) cur.text += dec(m[6]);
  }
  const textOf = (n) => n.text + n.children.map(textOf).join('');
  const wrap = (n) => n && {
    nodeName: n.nodeName,
    get textContent() { return textOf(n); },
    getAttribute: (k) => (k.toLowerCase() in n.attrs ? n.attrs[k.toLowerCase()] : null),
    querySelector: (sel) => wrap(find(n, sel, true)[0]),
    querySelectorAll: (sel) => find(n, sel, false).map(wrap),
  };
  function find(n, sel, first) {
    const out = [];
    const direct = sel.startsWith(':scope >');
    const tag = sel.replace(':scope >', '').trim().toLowerCase();
    const walk = (x) => {
      for (const c of x.children) {
        if (c.nodeName === tag) { out.push(c); if (first) return true; }
        if (!direct && walk(c)) return true;
      }
      return false;
    };
    walk(n);
    return out;
  }
  const docEl = root.children[0] || { nodeName: 'parsererror', children: [], attrs: {}, text: '' };
  return {
    documentElement: wrap(docEl),
    querySelector: (sel) => (sel === 'parsererror' ? (bad && !root.children.length ? {} : null) : wrap(find(root, sel, true)[0])),
    querySelectorAll: (sel) => find(root, sel, false).map(wrap),
  };
}

const ctx = { V: {}, TextDecoder, URL, URLSearchParams, atob, console, DOMParser: class { parseFromString(t) { return parseXmlDom(t); } } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'shared', 'm3u.js'), 'utf8'), ctx, { filename: 'm3u.js' });

module.exports = {
  decodeText: (buf) => ctx.V.decodeText(buf),
  /** -> { items, epgUrls, name, format, single, sawHeader } ; throws Error with a friendly message */
  parse: (text, base) => ctx.V.m3u.parse(text, { base }),
  episode: (name) => ctx.V.m3u.episode(name),
  generate: (entries, epgUrl) => ctx.V.m3u.generate(entries, epgUrl),
};
