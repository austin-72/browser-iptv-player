// The sign-in page's script. (A file of its own: the page's security policy only runs scripts that come from this server.)
// Older TV browsers (before Chrome 42) have no fetch(): a small stand-in, enough for this page.
if (!window.fetch && window.Promise) window.fetch = function (url, o) {
  o = o || {};
  return new Promise(function (resolve, reject) {
    var x = new XMLHttpRequest();
    x.open(o.method || 'GET', url, true);
    var h = o.headers || {};
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) x.setRequestHeader(k, h[k]);
    x.withCredentials = true;
    x.onload = function () { var t = x.responseText; resolve({ ok: x.status >= 200 && x.status < 300, status: x.status, json: function () { return Promise.resolve(t ? JSON.parse(t) : null); } }); };
    x.onerror = function () { reject(new TypeError('Failed to fetch')); };
    x.send(o.body || null);
  });
};
(function () {
  var f = document.getElementById('f'), pw = document.getElementById('pw'), go = document.getElementById('go'), err = document.getElementById('err'), eye = document.getElementById('eye');
  eye.onclick = function () { var show = pw.type === 'password'; pw.type = show ? 'text' : 'password'; eye.setAttribute('aria-pressed', show); eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); pw.focus(); };
  f.onsubmit = function (e) {
    e.preventDefault();
    go.disabled = true; err.textContent = '';
    fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App': '1' }, body: JSON.stringify({ password: pw.value }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || (r.status >= 500 ? 'The server isn’t answering properly right now (' + r.status + '). Try again in a moment.' : 'Sign-in failed')); location.replace('/' + location.hash); }); })
      .catch(function (x) { err.textContent = x instanceof TypeError ? 'Can’t reach the server.' : x.message; go.disabled = false; pw.select(); });
  };

  // Sign in with a phone: show a code (and QR code); a signed-in phone approves it.
  var pair = document.getElementById('pair'), timer = null, cur = null;
  function start() {
    var prev = (cur && cur.id) || '';
    try { prev = prev || sessionStorage.getItem('pairId') || ''; } catch (e) {}
    fetch('/api/pair/start', { method: 'POST', headers: { 'X-App': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ prev: prev }) }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Couldn’t get a code.'); return j; }); }).then(function (j) {
      cur = j;
      try { sessionStorage.setItem('pairId', j.id); } catch (e) {}
      document.getElementById('code').textContent = j.code;
      document.getElementById('qr').innerHTML = j.qr;
      document.getElementById('plink').textContent = j.link.replace(/^https?:\/\//, '');
      document.getElementById('pwait').textContent = 'Waiting for your phone…';
      clearInterval(timer);
      timer = setInterval(poll, 2000);
      setTimeout(function () { if (cur === j) start(); }, Math.max(60000, j.expires - Date.now() - 15000));
    }).catch(function (e) {
      // Couldn't get a code (offline, or too many asked for): say so and try again in a little while.
      cur = null; clearInterval(timer);
      document.getElementById('pwait').textContent = (e instanceof TypeError || !e || !e.message ? 'Can’t reach the server.' : e.message) + ' Trying again shortly…';
      clearTimeout(start._retry);
      start._retry = setTimeout(function () { if (!pair.classList.contains('hide') && !cur) start(); }, 20000);
    });
  }
  function poll() {
    if (!cur) return;
    fetch('/api/pair/' + cur.id + '?s=' + encodeURIComponent(cur.secret), { headers: { 'X-App': '1' } }).then(function (r) {
      if (r.status === 404 || r.status === 410) { start(); return; }
      return r.json().then(function (j) { if (j.ok) { clearInterval(timer); document.getElementById('pwait').textContent = 'Signed in!'; location.replace('/'); } });
    }).catch(function () {});
  }
  function show(phone) {
    f.classList.toggle('hide', phone); pair.classList.toggle('hide', !phone);
    if (phone) { start(); document.getElementById('usepw').focus(); } else { clearInterval(timer); cur = null; pw.focus(); }
  }
  document.getElementById('usephone').onclick = function () { show(true); };
  document.getElementById('usepw').onclick = function () { show(false); };
  // TVs: typing a password with a remote is no fun — start with the code.
  if (/SMART-TV|SmartTV|Tizen|Web0S|webOS|BRAVIA|AFT|CrKey|GoogleTV|Android TV|HbbTV|NetCast|Viera|AQUOS|PhilipsTV/i.test(navigator.userAgent)) { document.documentElement.className += ' tv'; show(true); }
})();
