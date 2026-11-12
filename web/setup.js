// The setup page's script (a new install: the site password and the admin profile). ES5, like login.js.
(function () {
  var f = document.getElementById('f'), pw = document.getElementById('pw'), name = document.getElementById('name'), pin = document.getElementById('pin');
  var go = document.getElementById('go'), err = document.getElementById('err'), eye = document.getElementById('eye');
  eye.onclick = function () { var show = pw.type === 'password'; pw.type = show ? 'text' : 'password'; eye.setAttribute('aria-pressed', show); eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); pw.focus(); };
  pin.addEventListener('input', function () { pin.value = pin.value.replace(/\D/g, '').slice(0, 8); });
  var say = function (msg, el) { err.textContent = msg; if (el) el.focus(); };
  f.onsubmit = function (e) {
    e.preventDefault();
    if (pw.value.length < 6) return say('Choose a site password of at least 6 characters.', pw);
    if (!name.value.trim()) return say('Give your profile a name.', name);
    if (!/^\d{4,8}$/.test(pin.value)) return say('The PIN is 4 to 8 digits.', pin);
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (x) {}
    go.disabled = true; err.textContent = '';
    var x = new XMLHttpRequest();
    x.open('POST', '/api/setup', true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.setRequestHeader('X-App', '1');
    x.onload = function () {
      var j = {};
      try { j = JSON.parse(x.responseText || '{}'); } catch (y) {}
      if (x.status >= 200 && x.status < 300) { location.replace('/?welcome=1#/setup'); return; }
      // (Set up from another device meanwhile: the sign-in page.)
      if (x.status === 409) { location.replace('/?signin=1'); return; }
      go.disabled = false;
      say(j.error || 'That didn’t work (' + x.status + '). Try again.');
    };
    x.onerror = function () { go.disabled = false; say('Can’t reach the server.'); };
    x.send(JSON.stringify({ password: pw.value, name: name.value.trim(), pin: pin.value, tz: tz }));
  };
})();
