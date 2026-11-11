/* The whole TV app: remembers the server's address and opens it. Everything else is the server's own pages.
   (Plain old JavaScript on purpose: TVs from 2016 run this.) */
(function () {
  'use strict';
  var KEY = 'server';
  var $ = function (id) { return document.getElementById(id); };
  var ask = $('ask'), wait = $('wait'), addr = $('addr'), err = $('err'), go = $('go');
  var timer = null, going = false;
  var saved = function () { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
  var save = function (v) { try { localStorage.setItem(KEY, v); } catch (e) {} };

  /** "192.168.1.20:8080" → "http://192.168.1.20:8080"; '' when it isn't an address. */
  function tidy(v) {
    v = String(v || '').replace(/^\s+|\s+$/g, '').replace(/\/+$/, '');
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
    return /^https?:\/\/[^\s\/?#]+(\/[^\s]*)?$/i.test(v) ? v : '';
  }
  function showAsk(message) {
    clearTimeout(timer); going = false;
    wait.hidden = true; ask.hidden = false;
    addr.value = addr.value || saved();
    err.textContent = message || '';
    addr.focus();
  }
  /** Is the server there? Its icon is asked for (no sign-in needed), with a few seconds to answer. */
  function reachable(url, yes, no) {
    var img = new Image(), done = false;
    var end = function (ok) { if (done) return; done = true; clearTimeout(t); (ok ? yes : no)(); };
    var t = setTimeout(function () { end(false); }, 8000);
    img.onload = function () { end(true); };
    img.onerror = function () { end(false); };
    img.src = url + '/icon.svg?t=' + Date.now();
  }
  function open(url) {
    if (going) return;
    going = true;
    err.textContent = 'Looking for it…';
    reachable(url, function () { save(url); location.replace(url + '/'); }, function () {
      showAsk('Nothing answered at ' + url + '. Check the address, and that this TV is on the same network as the server (or that the address works from outside).');
    });
  }
  function submit() {
    var url = tidy(addr.value);
    if (!url) { err.textContent = 'That doesn’t look like an address. It starts with http:// or https://'; return; }
    open(url);
  }
  go.onclick = submit;
  addr.onkeydown = function (e) { if (e.keyCode === 13) { e.preventDefault(); submit(); } };
  document.addEventListener('keydown', function (e) {
    // Up while it says "Opening…": change the address instead.
    if (!wait.hidden && (e.keyCode === 38 || e.key === 'ArrowUp')) { e.preventDefault(); showAsk(''); return; }
    // Left/right between the box and the button (TVs don't move the focus themselves).
    if (!ask.hidden && e.keyCode === 39 && document.activeElement === addr && addr.selectionStart === addr.value.length) { e.preventDefault(); go.focus(); }
    if (!ask.hidden && e.keyCode === 37 && document.activeElement === go) { e.preventDefault(); addr.focus(); }
    // Back on this page: leave the app.
    if (e.keyCode === 10009 || e.keyCode === 461) {
      try { if (window.tizen && tizen.application) { tizen.application.getCurrentApplication().exit(); return; } } catch (x) {}
      try { if (window.PalmSystem && PalmSystem.platformBack) { PalmSystem.platformBack(); return; } } catch (x) {}
      try { window.close(); } catch (x) {}
    }
  });

  var url = saved();
  if (!url) showAsk('');
  else {
    $('where').textContent = url.replace(/^https?:\/\//, '');
    wait.hidden = false;
    timer = setTimeout(function () { wait.hidden = true; ask.hidden = false; addr.value = url; open(url); }, 3000);
  }
})();
