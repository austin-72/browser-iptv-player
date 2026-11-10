/* Fill-ins for older smart-TV browsers (webOS 3–4, Tizen 3–4, old Android TV: Chrome 38–56), so the app runs there
   too. Each one is only added when the browser doesn't have it already. Plain ES5. */
(function () {
  'use strict';
  // Flex boxes without `gap` (Chrome before 84, Safari before 14.1): the stylesheet has margin fallbacks for them.
  try {
    var fx = document.createElement('div');
    fx.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
    fx.appendChild(document.createElement('div')); fx.appendChild(document.createElement('div'));
    document.documentElement.appendChild(fx);
    if (fx.scrollHeight !== 1) document.documentElement.className += ' no-flexgap';
    document.documentElement.removeChild(fx);
  } catch (e) {}
  var def = function (obj, name, fn) { if (!obj[name]) Object.defineProperty(obj, name, { value: fn, configurable: true, writable: true }); };

  def(Object, 'assign', function (t) { for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k]; } return t; });
  def(Object, 'values', function (o) { return Object.keys(o).map(function (k) { return o[k]; }); });
  def(Object, 'entries', function (o) { return Object.keys(o).map(function (k) { return [k, o[k]]; }); });
  def(Object, 'fromEntries', function (list) { var o = {}; Array.from(list).forEach(function (e) { o[e[0]] = e[1]; }); return o; });
  def(Array, 'from', function (x, fn) {
    var out = [];
    if (x == null) return out;
    if (typeof x.length === 'number') { for (var i = 0; i < x.length; i++) out.push(x[i]); }
    else if (typeof x.forEach === 'function') x.forEach(function (v, k) { out.push(x instanceof Map ? [k, v] : v); });
    return fn ? out.map(fn) : out;
  });
  def(Array.prototype, 'find', function (fn, t) { for (var i = 0; i < this.length; i++) if (fn.call(t, this[i], i, this)) return this[i]; });
  def(Array.prototype, 'findIndex', function (fn, t) { for (var i = 0; i < this.length; i++) if (fn.call(t, this[i], i, this)) return i; return -1; });
  def(Array.prototype, 'includes', function (x) { return this.indexOf(x) >= 0; });
  def(Array.prototype, 'fill', function (v) { for (var i = 0; i < this.length; i++) this[i] = v; return this; });
  def(String.prototype, 'includes', function (x, i) { return this.indexOf(x, i || 0) >= 0; });
  def(String.prototype, 'startsWith', function (x, i) { i = i || 0; return this.substr(i, x.length) === x; });
  def(String.prototype, 'endsWith', function (x) { return this.length >= x.length && this.substr(this.length - x.length) === x; });
  def(String.prototype, 'repeat', function (n) { var s = ''; for (var i = 0; i < n; i++) s += this; return s; });
  def(String.prototype, 'padStart', function (n, c) { var s = String(this); c = c === undefined ? ' ' : String(c); while (s.length < n) s = c + s; return s.slice(-n) === s ? s : s.slice(s.length - n); });
  def(String.prototype, 'padEnd', function (n, c) { var s = String(this); c = c === undefined ? ' ' : String(c); while (s.length < n) s += c; return s.slice(0, n); });
  def(Number, 'isFinite', function (x) { return typeof x === 'number' && isFinite(x); });

  var EP = window.Element && Element.prototype;
  if (EP) {
    def(EP, 'matches', EP.webkitMatchesSelector || EP.msMatchesSelector || function (s) { var m = (this.ownerDocument || document).querySelectorAll(s); for (var i = 0; i < m.length; i++) if (m[i] === this) return true; return false; });
    def(EP, 'closest', function (s) { var el = this; while (el && el.nodeType === 1) { if (el.matches(s)) return el; el = el.parentNode; } return null; });
    def(EP, 'remove', function () { if (this.parentNode) this.parentNode.removeChild(this); });
    def(EP, 'replaceWith', function (n) { if (this.parentNode) this.parentNode.replaceChild(n, this); });
    def(EP, 'append', function () { for (var i = 0; i < arguments.length; i++) this.appendChild(typeof arguments[i] === 'string' ? document.createTextNode(arguments[i]) : arguments[i]); });
    def(EP, 'toggleAttribute', function (n, f) { var on = f === undefined ? !this.hasAttribute(n) : !!f; if (on) this.setAttribute(n, ''); else this.removeAttribute(n); return on; });
  }
  if (window.NodeList) def(NodeList.prototype, 'forEach', Array.prototype.forEach);

  // URLSearchParams: get / set / delete / has / toString / forEach (what the app uses).
  if (!window.URLSearchParams) {
    var USP = function (init) {
      this._l = [];
      var self = this;
      if (init && typeof init === 'object' && init._l) { this._l = init._l.slice(); return; }
      if (init && typeof init === 'object') { Object.keys(init).forEach(function (k) { self._l.push([k, String(init[k])]); }); return; }
      String(init || '').replace(/^\?/, '').split('&').forEach(function (p) {
        if (!p) return;
        var i = p.indexOf('='), dec = function (x) { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch (e) { return x; } };
        self._l.push(i < 0 ? [dec(p), ''] : [dec(p.slice(0, i)), dec(p.slice(i + 1))]);
      });
    };
    USP.prototype.get = function (k) { for (var i = 0; i < this._l.length; i++) if (this._l[i][0] === k) return this._l[i][1]; return null; };
    USP.prototype.has = function (k) { return this.get(k) !== null; };
    USP.prototype.set = function (k, v) { this.delete(k); this._l.push([k, String(v)]); };
    USP.prototype.append = function (k, v) { this._l.push([k, String(v)]); };
    USP.prototype['delete'] = function (k) { this._l = this._l.filter(function (e) { return e[0] !== k; }); };
    USP.prototype.forEach = function (fn) { var self = this; this._l.forEach(function (e) { fn(e[1], e[0], self); }); };
    USP.prototype.toString = function () { return this._l.map(function (e) { return encodeURIComponent(e[0]) + '=' + encodeURIComponent(e[1]); }).join('&'); };
    window.URLSearchParams = USP;
  }

  // fetch (Chrome < 42): enough for this app — method, headers, body, credentials; text/json/blob, status, headers.get.
  if (!window.fetch) {
    window.fetch = function (url, o) {
      o = o || {};
      return new Promise(function (resolve, reject) {
        var x = new XMLHttpRequest();
        x.open(o.method || 'GET', url, true);
        x.withCredentials = o.credentials === 'include';
        var h = o.headers || {};
        Object.keys(h).forEach(function (k) { x.setRequestHeader(k, h[k]); });
        x.responseType = 'blob';
        if (o.signal) o.signal.addEventListener('abort', function () { x.abort(); });
        x.onload = function () {
          var blob = x.response;
          var readText = function () { return new Promise(function (ok) { var r = new FileReader(); r.onload = function () { ok(r.result); }; r.readAsText(blob); }); };
          resolve({
            ok: x.status >= 200 && x.status < 300, status: x.status, url: x.responseURL || url,
            headers: { get: function (n) { return x.getResponseHeader(n); } },
            text: readText, json: function () { return readText().then(JSON.parse); }, blob: function () { return Promise.resolve(blob); },
          });
        };
        x.onerror = function () { reject(new TypeError('Failed to fetch')); };
        x.onabort = function () { var e = new Error('Aborted'); e.name = 'AbortError'; reject(e); };
        x.send(o.body === undefined ? null : o.body);
      });
    };
  }
  if (!window.AbortController) {
    window.AbortController = function () {
      var ls = [];
      this.signal = { aborted: false, addEventListener: function (t, fn) { ls.push(fn); }, removeEventListener: function () {} };
      var sig = this.signal;
      this.abort = function () { if (sig.aborted) return; sig.aborted = true; ls.forEach(function (fn) { try { fn(); } catch (e) {} }); };
    };
  }
  // IntersectionObserver (Chrome < 51, the PS4): where each thing is, compared with the screen (plus rootMargin), checked
  // when something scrolls or the window changes size — a few times a second at most. (Saying everything is visible
  // straight away made long lists, like 5,000 channels, draw every row in one go.)
  if (!window.IntersectionObserver) {
    var ioAll = [], ioLast = 0, ioTimer = null;
    var ioCheckAll = function () { ioTimer = null; ioLast = Date.now(); ioAll.slice().forEach(function (o) { o._check(); }); };
    var ioSoon = function () { if (!ioTimer) ioTimer = setTimeout(ioCheckAll, Math.max(16, 150 - (Date.now() - ioLast))); };
    window.addEventListener('resize', ioSoon);
    document.addEventListener('scroll', ioSoon, true); // (scrolling inside a list or a row too)
    window.IntersectionObserver = function (cb, opts) {
      opts = opts || {};
      var self = this, els = [];
      var px = String(opts.rootMargin || '0px').split(/\s+/).map(function (x) { return parseFloat(x) || 0; });
      var mt = px[0], mr = px.length > 1 ? px[1] : mt, mb = px.length > 2 ? px[2] : mt, ml = px.length > 3 ? px[3] : mr;
      var thr = [].concat(opts.threshold || 0)[0] || 0;
      var drop = function () { var i = ioAll.indexOf(self); if (i >= 0) ioAll.splice(i, 1); };
      this._check = function () {
        var out = [], vw = window.innerWidth || document.documentElement.clientWidth, vh = window.innerHeight || document.documentElement.clientHeight;
        // (Something no longer on the page is forgotten, so a page left without disconnect() doesn't keep it.)
        els = els.filter(function (x) { return document.documentElement.contains(x.el); });
        els.forEach(function (x) {
          var hit = false, ratio = 0;
          if (x.el.getClientRects().length) { // (not display:none)
            var r = x.el.getBoundingClientRect();
            var w = Math.min(r.right, vw + mr) - Math.max(r.left, -ml), h = Math.min(r.bottom, vh + mb) - Math.max(r.top, -mt);
            var area = r.width * r.height;
            ratio = w >= 0 && h >= 0 ? (area ? Math.max(0, w) * Math.max(0, h) / area : 1) : 0;
            hit = w >= 0 && h >= 0 && ratio >= thr;
          }
          if (hit !== x.hit) { x.hit = hit; out.push({ target: x.el, isIntersecting: hit, intersectionRatio: ratio, time: Date.now() }); }
        });
        if (!els.length) drop();
        if (out.length) cb(out, self);
      };
      this.observe = function (el) {
        if (els.some(function (x) { return x.el === el; })) return;
        els.push({ el: el, hit: null }); // (the first check always reports, in view or not, like the real one)
        if (ioAll.indexOf(self) < 0) ioAll.push(self);
        ioSoon();
      };
      this.unobserve = function (el) { els = els.filter(function (x) { return x.el !== el; }); if (!els.length) drop(); };
      this.disconnect = function () { els = []; drop(); };
      this.takeRecords = function () { return []; };
    };
  }
  // node.isConnected (Chrome before 54): "is this still on the page?"
  if (window.Node && !('isConnected' in Node.prototype)) {
    try { Object.defineProperty(Node.prototype, 'isConnected', { configurable: true, get: function () { var d = this.ownerDocument || document; return d.documentElement ? d.documentElement.contains(this) || this === d : false; } }); } catch (e) {}
  }
  // element.scrollBy / scrollTo (Chrome before 61): rows of posters scroll with these.
  var EP = window.Element && Element.prototype;
  if (EP && !EP.scrollBy) EP.scrollBy = function (a, b) { if (a && typeof a === 'object') { this.scrollLeft += a.left || 0; this.scrollTop += a.top || 0; } else { this.scrollLeft += +a || 0; this.scrollTop += +b || 0; } };
  if (EP && !EP.scrollTo) EP.scrollTo = function (a, b) { if (a && typeof a === 'object') { if (a.left != null) this.scrollLeft = a.left; if (a.top != null) this.scrollTop = a.top; } else { this.scrollLeft = +a || 0; this.scrollTop = +b || 0; } };
  // KeyboardEvent.key (Chrome before 51 — 2015–17 TVs only have keyCode): the app reads key names everywhere,
  // including the remote's arrows, OK and Back.
  if (window.KeyboardEvent && !('key' in KeyboardEvent.prototype)) {
    var KEYS = { 8: 'Backspace', 9: 'Tab', 13: 'Enter', 19: 'MediaPause', 27: 'Escape', 32: ' ', 33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
      37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 46: 'Delete', 93: 'ContextMenu', 179: 'MediaPlayPause', 188: ',', 190: '.',
      191: '/', 412: 'MediaRewind', 413: 'MediaStop', 415: 'MediaPlay', 417: 'MediaFastForward', 427: 'ChannelUp', 428: 'ChannelDown', 457: 'Info',
      10252: 'MediaPlayPause', 10232: 'MediaTrackPrevious', 10233: 'MediaTrackNext' };
    try {
      Object.defineProperty(KeyboardEvent.prototype, 'key', { configurable: true, get: function () {
        var c = this.keyCode || this.which;
        if (this.shiftKey && (c === 191 || c === 188 || c === 190)) return { 191: '?', 188: '<', 190: '>' }[c];
        if (KEYS[c]) return KEYS[c];
        if (c >= 48 && c <= 57) return String.fromCharCode(c);
        if (c >= 96 && c <= 105) return String(c - 96); // number pad / remote digits
        if (c >= 65 && c <= 90) { var ch = String.fromCharCode(c); return this.shiftKey ? ch : ch.toLowerCase(); }
        return this.keyIdentifier || 'Unidentified';
      } });
    } catch (e) {}
  }
  // video.play() gives nothing back on Chrome before 50: `.catch` on it threw (pause/resume, back to live, multiview).
  try {
    var mp = window.HTMLMediaElement && HTMLMediaElement.prototype, op = mp && mp.play;
    if (op && !op._wrapped) {
      mp.play = function () { var r = op.apply(this, arguments); return r && r.then ? r : (window.Promise ? Promise.resolve() : r); };
      mp.play._wrapped = true;
    }
  } catch (e) {}
  // scrollIntoView({ block: 'nearest' … }): browsers that don't know the options (Chrome before 61 — Tizen up to 4,
  // webOS up to 4) read them as "align to the top", so every arrow press snapped the row under the top bar. There:
  // nothing when it's already in view, otherwise aligned to the edge it's nearest.
  try {
    if (!('scrollBehavior' in document.documentElement.style) && window.Element && Element.prototype.scrollIntoView) {
      var osv = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (o) {
        if (!o || typeof o !== 'object') return osv.apply(this, arguments);
        var r = this.getBoundingClientRect(), h = window.innerHeight || document.documentElement.clientHeight, w = window.innerWidth || document.documentElement.clientWidth;
        if (o.block === 'center') { window.scrollBy(0, r.top + r.height / 2 - h / 2); return; }
        if (r.top >= 70 && r.bottom <= h && r.left >= 0 && r.right <= w) return;
        if (r.left < 0 || r.right > w) osv.call(this, r.top < 70);
        else if (r.top < 70) window.scrollBy(0, r.top - 80);
        else window.scrollBy(0, r.bottom - h + 16);
      };
    }
  } catch (e) {}
  // requestAnimationFrame / performance.now are old enough everywhere; CSS.escape is used by nothing.
})();
