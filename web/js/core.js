/* Core helpers shared by every screen. Written for older smart-TV browsers too: no optional chaining or ?? */
'use strict';
var V = (window.V = window.V || {});
var S = (V.S = {});

V.$ = function (s, r) { return (r || document).querySelector(s); };
V.$$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
V.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
V.icon = function (n, cls) { return '<svg class="i ' + (cls || '') + '" aria-hidden="true" focusable="false"><use href="#i-' + n + '" xlink:href="#i-' + n + '"/></svg>'; }; // (xlink:href for browsers before Chrome 50)
V.uid = function () { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); };
V.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
/** The n entries of `lists` (one array or several) with the highest score(x) > 0, best first — without sorting everything. */
V.topN = function (lists, n, score) {
  var top = [], sc = [];
  if (!Array.isArray(lists[0])) lists = [lists];
  for (var l = 0; l < lists.length; l++) {
    var list = lists[l];
    for (var i = 0; i < list.length; i++) {
      var s = score(list[i]);
      if (!(s > 0) || (top.length >= n && s <= sc[top.length - 1])) continue;
      var lo = 0, hi = top.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (sc[mid] >= s) lo = mid + 1; else hi = mid; }
      top.splice(lo, 0, list[i]); sc.splice(lo, 0, s);
      if (top.length > n) { top.pop(); sc.pop(); }
    }
  }
  return top;
};
V.debounce = function (fn, ms) { var t; return function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms); }; };
V.throttle = function (fn, ms) { var last = 0, t; return function () { var a = arguments, now = Date.now(); clearTimeout(t); if (now - last >= ms) { last = now; fn.apply(null, a); } else t = setTimeout(function () { last = Date.now(); fn.apply(null, a); }, ms - (now - last)); }; };
V.clamp = function (x, a, b) { return Math.min(b, Math.max(a, x)); };
V.pick = function (o, k, d) { return o && o[k] != null ? o[k] : d; };
V.hash = function (str, seed) {
  var h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
  for (var i = 0; i < str.length; i++) { var ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};
V.norm = function (s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9Ѐ-ӿ؀-ۿ぀-ヿ一-鿿가-힯]+/g, ' ').trim();
};

// ---------- formatting
V.plural = function (n, one, many) { return Number(n).toLocaleString() + ' ' + (n === 1 ? one : (many || one + 's')); };
V.fmtClock = function (ms) { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
V.fmtDur = function (sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
};
V.fmtLen = function (sec) {
  if (!sec) return '';
  var m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60 ? (m % 60) + ' min' : '') : m + ' min';
};
V.fmtLeft = function (sec) { var m = Math.max(1, Math.round(sec / 60)); return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min left' : m + ' min left'; };
V.fmtAgo = function (ms) {
  if (!ms) return 'never';
  var s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 7 * 86400) return Math.floor(s / 86400) + ' d ago';
  return new Date(ms).toLocaleDateString();
};
V.fmtDay = function (ms) {
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var diff = Math.round((new Date(ms).setHours(0, 0, 0, 0) - today) / 86400e3);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};
V.fmtBits = function (bps) { if (!bps) return '–'; return bps >= 1e6 ? (bps / 1e6).toFixed(1) + ' Mbps' : Math.round(bps / 1e3) + ' kbps'; };
V.fmtSize = function (b) { if (!b) return '0 B'; var u = ['B', 'KB', 'MB', 'GB', 'TB']; var i = Math.min(4, Math.floor(Math.log(b) / Math.log(1024))); return (b / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + u[i]; };
V.initials = function (s) { return String(s || '?').replace(/[^\w\sÀ-￿]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase() || '?'; };
V.epLabel = function (it) { return it && it.s != null ? 'S' + it.s + ':E' + it.e : ''; };

// ---------- storage on this device
V.ls = {
  get: function (k, d) { try { var v = localStorage.getItem('ip.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: function (k, v) { try { localStorage.setItem('ip.' + k, JSON.stringify(v)); } catch (e) {} },
  del: function (k) { try { localStorage.removeItem('ip.' + k); } catch (e) {} },
  /** This tab only, until it's closed: session(k) reads, session(k, v) writes. */
  session: function (k, v) {
    var set = arguments.length > 1;
    if (set) (V._sess || (V._sess = {}))[k] = v; // (also kept in memory, for when the browser blocks sessionStorage)
    try { if (set) { sessionStorage.setItem('ip.' + k, JSON.stringify(v)); return v; } var x = sessionStorage.getItem('ip.' + k); return x == null ? null : JSON.parse(x); } catch (e) { return set ? v : (V._sess || {})[k]; }
  },
};
V.idb = (function () {
  var dbp = null;
  function db() {
    if (!dbp) dbp = new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error('no indexedDB'));
      var r = indexedDB.open('iptv-player', 2);
      r.onupgradeneeded = function () { var d = r.result; if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); if (!d.objectStoreNames.contains('dl')) d.createObjectStore('dl'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function op(store, mode, fn) {
    return db().then(function (d) { return new Promise(function (res, rej) { var tx = d.transaction(store, mode); var r = fn(tx.objectStore(store)); tx.oncomplete = function () { res(r && r.result); }; tx.onerror = function () { rej(tx.error); }; }); });
  }
  return {
    get: function (k, store) { return op(store || 'kv', 'readonly', function (s) { return s.get(k); }).catch(function () { return undefined; }); },
    set: function (k, v, store) { return op(store || 'kv', 'readwrite', function (s) { return s.put(v, k); }).catch(function () {}); },
    del: function (k, store) { return op(store || 'kv', 'readwrite', function (s) { return s.delete(k); }).catch(function () {}); },
    all: function (store) { return op(store || 'kv', 'readonly', function (s) { return s.getAll(); }).catch(function () { return []; }); },
    keys: function (store) { return op(store || 'kv', 'readonly', function (s) { return s.getAllKeys(); }).catch(function () { return []; }); },
  };
})();

// ---------- this device
V.device = (function () {
  var id = V.ls.get('device');
  if (!id) { id = V.uid(); V.ls.set('device', id); }
  var ua = navigator.userAgent;
  var tv = /Tizen|SMART-TV|SmartTV|Web0S|webOS|NetCast|BRAVIA|AFT[A-Z]|CrKey|GoogleTV|Android TV|HbbTV|Viera|Roku|PlayStation|Xbox/i.test(ua);
  var touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  var os = /iPhone/.test(ua) ? 'iPhone' : /iPad|Macintosh.*Mobile/.test(ua) ? 'iPad' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : tv ? 'Android TV' : 'Android tablet') : tv ? 'TV' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /CrOS/.test(ua) ? 'Chromebook' : 'Computer';
  var br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return { id: id, tv: tv, touch: touch, ios: /iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && touch), name: V.ls.get('deviceName') || (br ? br + ' on ' + os : os) };
})();

// ---------- events
V._ev = {};
V.on = function (n, fn) { (V._ev[n] = V._ev[n] || []).push(fn); return function () { V.off(n, fn); }; };
V.off = function (n, fn) { V._ev[n] = (V._ev[n] || []).filter(function (x) { return x !== fn; }); };
V.emit = function (n, d) { (V._ev[n] || []).slice().forEach(function (fn) { try { fn(d); } catch (e) { console.error(e); } }); };

// ---------- server calls
V.api = function (path, opts) {
  opts = opts || {};
  var h = { 'X-App': '1' };
  if (S.conn) h['X-Conn'] = S.conn;
  var body = opts.body;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  return fetch(path, { method: opts.method || (body !== undefined ? 'POST' : 'GET'), headers: Object.assign(h, opts.headers || {}), body: body, keepalive: !!opts.keepalive, credentials: 'same-origin', signal: opts.signal })
    .catch(function (e) { var err = new Error(navigator.onLine === false ? 'You’re offline.' : 'Can’t reach the server.'); err.offline = true; err.cause = e; throw err; })
    .then(function (r) {
      if (opts.raw) return r;
      if (r.status === 401 && !opts.allow401) { V.emit('signedout'); }
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) { var err = new Error((j && j.error) || ('Server error ' + r.status)); err.status = r.status; throw err; }
        return j;
      });
    });
};
V.put = function (path, body) { return V.api(path, { method: 'PUT', body: body }); };
V.del = function (path, body) { return V.api(path, { method: 'DELETE', body: body }); };

// ---------- feedback
V.announce = function (text) { var el = V.$('#sr-live'); if (!el) return; el.textContent = ''; setTimeout(function () { el.textContent = text; }, 50); };
V.toast = function (msg, o) {
  o = o || {};
  var box = V.$('#toasts');
  if (!box) return;
  var t = document.createElement('div');
  t.className = 'toast' + (o.error ? ' error' : '');
  t.setAttribute('role', o.error ? 'alert' : 'status');
  t.innerHTML = '<span>' + V.esc(msg) + '</span>' + (o.action ? '<button class="toast-act">' + V.esc(o.action.label) + '</button>' : '') + '<button class="toast-x" aria-label="Dismiss">' + V.icon('x') + '</button>';
  var close = function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 250); };
  if (o.action) t.querySelector('.toast-act').onclick = function () { o.action.fn(); close(); };
  t.querySelector('.toast-x').onclick = close;
  box.appendChild(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(close, o.ms || (o.action ? 8000 : 4200));
  return close;
};
V.fail = function (e) { if (e && e.name === 'AbortError') return; console.warn(e); V.toast((e && e.message) || String(e), { error: true }); };

// ---------- dialogs (native <dialog>, so focus and Escape work everywhere)
V.dialog = function (o) {
  return new Promise(function (resolve) {
    var d = document.createElement('dialog');
    d.className = 'dlg' + (o.wide ? ' wide' : '') + (o.cls ? ' ' + o.cls : '');
    if (o.title) d.setAttribute('aria-label', o.title);
    d.innerHTML = (o.title ? '<header class="dlg-h"><h2>' + V.esc(o.title) + '</h2><button class="icon-btn dlg-x" data-x aria-label="Close">' + V.icon('x') + '</button></header>' : '') +
      '<div class="dlg-b"></div>' + (o.actions && o.actions.length ? '<footer class="dlg-f"></footer>' : '');
    var b = d.querySelector('.dlg-b');
    if (typeof o.body === 'string') b.innerHTML = o.body; else if (o.body) b.appendChild(o.body);
    var done = false;
    var veil = null, escKey = null;
    var finish = function (v) { if (done) return; done = true; try { d.close(); } catch (e) {} d.remove(); if (veil) veil.remove(); if (escKey) document.removeEventListener('keydown', escKey, true); if (o.onClose) o.onClose(v); resolve(v); };
    (o.actions || []).forEach(function (a) {
      var btn = document.createElement('button');
      btn.className = 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '');
      btn.type = 'button';
      btn.textContent = a.label;
      btn.onclick = function () {
        if (!a.fn) return finish(a.value);
        var r;
        try { r = a.fn(d, finish); } catch (e) { return V.fail(e); }
        if (r && r.then) { btn.disabled = true; r.then(function (v) { if (v !== false) finish(v === undefined ? a.value : v); else btn.disabled = false; }, function (e) { btn.disabled = false; V.fail(e); }); } else if (r !== false) finish(r === undefined ? a.value : r);
      };
      d.querySelector('.dlg-f').appendChild(btn);
    });
    d.addEventListener('click', function (e) { if (e.target.closest('[data-x]')) finish(null); if (e.target === d && o.dismiss !== false) finish(null); });
    d.addEventListener('cancel', function (e) { e.preventDefault(); if (o.dismiss !== false) finish(null); });
    d._finish = finish;
    // Going to another page (Back on a remote or phone) closes it: it belongs to the page it was opened on.
    var opened = Date.now();
    d._routeClose = function () { if (o.dismiss !== false && Date.now() - opened > 400) finish(null); };
    d._dismiss = function () { if (o.dismiss !== false) finish(null); }; // (the Back button on a TV remote)
    document.body.appendChild(d);
    if (d.showModal) d.showModal();
    else {
      // Browsers without <dialog> (Safari before 15.4, some TVs): centre it over a dimmed page ourselves.
      d.setAttribute('open', '');
      d.className += ' dlg-fallback';
      veil = document.createElement('div');
      veil.className = 'dlg-veil';
      veil.onclick = function () { if (o.dismiss !== false) finish(null); };
      document.body.insertBefore(veil, d);
      // Escape closes only the top dialog (each one listens, so the others must not hear it too).
      escKey = function (e) {
        if (!(e.key === 'Escape' || e.keyCode === 27) || V.$$('dialog[open]').pop() !== d) return;
        e.preventDefault(); if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        if (o.dismiss !== false) finish(null);
      };
      document.addEventListener('keydown', escKey, true);
    }
    if (o.onOpen) o.onOpen(d, finish);
    var f = d.querySelector('[autofocus]') || d.querySelector('.dlg-b input, .dlg-b select, .dlg-b textarea, .dlg-b button, .dlg-f .primary');
    if (f) setTimeout(function () { f.focus(); }, 30);
  });
};
V.confirm = function (text, o) {
  o = o || {};
  return V.dialog({ title: o.title || 'Are you sure?', body: '<p>' + V.esc(text) + '</p>', actions: [{ label: o.cancel || 'Cancel', value: false }, { label: o.ok || 'OK', primary: !o.danger, danger: !!o.danger, value: true }] }).then(function (v) { return !!v; });
};
V.prompt = function (title, o) {
  o = o || {};
  return V.dialog({
    title: title,
    body: (o.text ? '<p>' + V.esc(o.text) + '</p>' : '') + '<label class="field"><span>' + V.esc(o.label || '') + '</span><input class="input" data-v type="' + (o.type || 'text') + '" value="' + V.esc(o.value || '') + '" placeholder="' + V.esc(o.placeholder || '') + '" ' + (o.max ? 'maxlength="' + o.max + '"' : '') + ' autofocus></label>',
    actions: [{ label: 'Cancel', value: null }, { label: o.ok || 'OK', primary: true, fn: function (d) { return d.querySelector('[data-v]').value; } }],
    onOpen: function (d, finish) { d.querySelector('[data-v]').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); finish(e.target.value); } }); },
  });
};

/** A small popup menu next to a button. items: [{label, icon, fn, danger, checked, sep}] */
V.menu = function (anchor, items, o) {
  o = o || {};
  V.closeMenus();
  var m = document.createElement('div');
  m.className = 'popmenu';
  m.setAttribute('role', 'menu');
  m.innerHTML = items.filter(Boolean).map(function (it, i) {
    if (it.sep) return '<div class="pm-sep" role="separator"></div>';
    if (it.header) return '<div class="pm-h">' + V.esc(it.header) + '</div>';
    return '<button class="pm-i' + (it.danger ? ' danger' : '') + '" role="' + (it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem') + '"' + (it.checked !== undefined ? ' aria-checked="' + !!it.checked + '"' : '') + ' data-i="' + i + '">' +
      (it.icon ? V.icon(it.icon) : '') + '<span>' + V.esc(it.label) + '</span>' + (it.checked ? V.icon('check', 'pm-c') : '') + (it.hint ? '<small>' + V.esc(it.hint) + '</small>' : '') + '</button>';
  }).join('');
  document.body.appendChild(m);
  var r = anchor.getBoundingClientRect();
  var mw = m.offsetWidth, mh = m.offsetHeight;
  var left = o.align === 'left' ? r.left : r.right - mw;
  left = V.clamp(left, 8, window.innerWidth - mw - 8);
  var top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  m.addEventListener('click', function (e) {
    var b = e.target.closest('[data-i]');
    if (!b) return;
    var it = items.filter(Boolean)[+b.dataset.i];
    V.closeMenus();
    if (it && it.fn) it.fn();
  });
  // Arrow keys (a TV remote) stay inside the menu.
  m.addEventListener('keydown', function (e) {
    var step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (step) {
      e.preventDefault(); e.stopPropagation();
      var list = V.$$('.pm-i', m), i = list.indexOf(document.activeElement);
      var n = list[(i + step + list.length) % list.length];
      if (n) n.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); }
  });
  m._anchor = anchor;
  setTimeout(function () { var f = m.querySelector('.pm-i'); if (f) f.focus(); }, 20);
  return m;
};
V.closeMenus = function () { V.$$('.popmenu').forEach(function (m) { var a = m._anchor; m.remove(); if (a && document.activeElement === document.body) a.focus(); }); };
document.addEventListener('pointerdown', function (e) { if (!e.target.closest('.popmenu')) V.closeMenus(); }, true);
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && V.$('.popmenu')) { e.stopPropagation(); V.closeMenus(); } }, true);

V.copy = function (text, msg) {
  var done = function () { V.toast(msg || 'Copied'); };
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(done, function () { V.prompt('Copy this', { value: text }); });
  var ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { V.prompt('Copy this', { value: text }); }
  ta.remove();
};
V.download = function (name, data, type) {
  var blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
};
V.loadScript = (function () {
  var cache = {};
  return function (src) {
    if (!cache[src]) cache[src] = new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = function () { delete cache[src]; rej(new Error('Couldn’t load ' + src)); }; document.head.appendChild(s); });
    return cache[src];
  };
})();

// Artwork with a fallback to initials (one listener for the whole page).
V.art = function (src, name, cls) {
  return '<div class="' + (cls || 'art') + '">' + (src ? '<img src="' + V.esc(src) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="' + V.esc(V.initials(name)) + '">' : '<span class="ini">' + V.esc(V.initials(name)) + '</span>') + '</div>';
};
// A picture that doesn't load: try the other source (TMDB ↔ provider), then a tinted tile with the title.
document.addEventListener('error', function (e) {
  var img = e.target;
  if (!img || img.tagName !== 'IMG') return;
  // Any other picture that doesn't load (backdrops, episode stills): hide it rather than show a broken-image icon.
  if (img.dataset.fallback === undefined) { img.style.visibility = 'hidden'; img.setAttribute('data-hid', ''); return; }
  if (img.dataset.alt) { var a = img.dataset.alt; img.removeAttribute('data-alt'); img.src = a; return; }
  var s = document.createElement('span');
  s.className = 'ini';
  s.textContent = img.dataset.fallback;
  var title = img.dataset.title;
  var parent = img.parentNode;
  img.replaceWith(s);
  // A poster that's missing becomes a plain title card: the name, large, instead of initials.
  if (title && parent && !parent.querySelector('.card-tt')) { s.hidden = true; var t = document.createElement('span'); t.className = 'card-tt big'; t.textContent = title; parent.insertBefore(t, s.nextSibling); }
}, true);

// …and shown again when that same picture is later given something that does load (a backdrop, the next seek preview).
document.addEventListener('load', function (e) {
  var img = e.target;
  if (img && img.tagName === 'IMG' && img.hasAttribute('data-hid')) { img.removeAttribute('data-hid'); img.style.visibility = ''; }
}, true);

/** A colour that stays stable for a string (used behind text-only cards). */
V.tint = function (s) { var h = parseInt(V.hash(String(s)).slice(0, 6), 36) % 360; return 'hsl(' + h + ',35%,28%)'; };

V.avatar = function (i, cls) {
  // An uploaded photo: "img:<profile id>:<version>"
  if (typeof i === 'string' && i.indexOf('img:') === 0) {
    var parts = i.split(':');
    return '<span class="avatar photo ' + (cls || '') + '"><img src="/api/avatar/' + encodeURIComponent(parts[1]) + '?v=' + encodeURIComponent(parts[2] || '') + '" alt="" decoding="async"></span>';
  }
  var A = window.AVATARS;
  var n = A ? ((+i || 0) % A.count + A.count) % A.count : 0;
  return '<span class="avatar ' + (cls || '') + '">' + (A ? A.svg(n) : '') + '</span>';
};
