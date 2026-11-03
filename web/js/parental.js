/* Parental locks (Admin → Channels): locked channels, categories and titles arrive without their stream addresses.
   Entering the parental PIN unlocks them on this device for 30 minutes; the server checks it too. */
'use strict';
V.parental = (function () {
  var until = 0, timer = null;
  var lockedOf = function (it) {
    if (!it) return false;
    if (it.lk) return true;
    if (it.t === 'catchup') return lockedOf(V.entry(it.catchupOf));
    if (it.sk) { var show = V.entry(it.sk); return !!(show && show.lk); }
    return false;
  };
  var isOpen = function () { return until > Date.now(); };

  // Once unlocked: fetch the locked items' addresses and listings and fill them in (and again after each catalogue load).
  function fill() {
    if (!isOpen() || !S.items) return Promise.resolve();
    var keys = S.items.filter(function (it) { return it.lk && !it.u && it.t !== 'show'; }).map(function (it) { return it.k; });
    if (!keys.length) return Promise.resolve();
    var chunks = [];
    for (var i = 0; i < keys.length; i += 400) chunks.push(keys.slice(i, i + 400));
    return Promise.all(chunks.map(function (c) {
      return V.api('/api/parental/items?keys=' + c.map(encodeURIComponent).join(',')).then(function (r) {
        r.items.forEach(function (x) { var it = V.entry(x.k); if (!it) return; ['u', 'a', 'h', 'E'].forEach(function (f) { if (x[f] !== undefined) it[f] = x[f]; }); });
        V.epg.inject(r.guide);
        if (r.until) until = r.until;
      });
    })).then(function () { V.emit('parental'); });
  }
  // When the 30 minutes are up: take the addresses away again.
  function close() {
    until = 0;
    if (S.items) S.items.forEach(function (it) { if (it.lk) { delete it.u; delete it.a; delete it.h; } });
    V.emit('parental');
  }
  function schedule() { clearTimeout(timer); if (isOpen()) timer = setTimeout(close, Math.min(until - Date.now() + 500, 2147483000)); }

  function ask(it) {
    if (S.profile && S.profile.kids) { V.toast('That’s locked.', { error: true }); return Promise.resolve(false); }
    if (!S.settings.parentalPin) { V.toast('That’s locked, and no parental PIN has been set yet. Ask the admin (Admin → Channels).', { error: true, ms: 7000 }); return Promise.resolve(false); }
    return V.dialog({
      title: 'Parental PIN',
      body: '<p>' + V.esc(it && it.n ? '“' + it.n + '” is locked.' : 'This is locked.') + ' Enter the parental PIN to unlock locked channels on this device for 30 minutes.</p><label class="field"><span>PIN</span><input class="input pin-in" data-pin type="password" inputmode="numeric" autocomplete="off" maxlength="8" autofocus></label><p class="err small" data-err hidden></p>',
      actions: [{ label: 'Cancel', value: false }, { label: 'Unlock', primary: true, fn: function (d) { return submit(d); } }],
      onOpen: function (d, finish) { V.$('[data-pin]', d).addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(d).then(function (ok) { if (ok) finish(true); }, V.fail); } }); },
    }).then(function (ok) { return !!ok; });
  }
  function submit(d) {
    var pin = V.$('[data-pin]', d).value;
    var err = V.$('[data-err]', d);
    // (Enter and Unlock together, or Enter twice, send it once: a wrong PIN sent twice counts twice.)
    if (d._busy) return Promise.resolve(false);
    if (!pin) { err.hidden = false; err.textContent = 'Enter the PIN first.'; V.$('[data-pin]', d).focus(); return Promise.resolve(false); }
    d._busy = true;
    return V.api('/api/parental/unlock', { body: { pin: pin } }).then(function (r) {
      until = r.until;
      schedule();
      return fill().then(function () { return true; }, function (e) { d._busy = false; throw e; });
    }, function (e) { d._busy = false; err.hidden = false; err.textContent = e.message; V.$('[data-pin]', d).value = ''; V.$('[data-pin]', d).focus(); return false; });
  }

  // Playing something locked asks for the PIN first.
  var guard = function (name) {
    var orig = V[name];
    if (!orig || orig._parental) return;
    V[name] = function (it) {
      var args = arguments, self = this;
      if (lockedOf(it) && !isOpen()) { ask(it).then(function (ok) { if (ok) orig.apply(self, args); }); return; }
      return orig.apply(self, args);
    };
    V[name]._parental = true;
  };
  var checked = '';
  V.on('catalog', function () {
    // (Once per profile: is this device still unlocked from before a reload?)
    var pid = S.profile ? S.profile.id : '';
    if (pid && checked !== pid) { checked = pid; until = 0; V.api('/api/parental').then(function (r) { if (r.until) { until = r.until; schedule(); fill(); } }).catch(function () {}); return; }
    if (isOpen()) fill();
  });
  guard('play'); guard('playCatchup');
  // Lists that show "Locked" in place of what's on: draw them again.
  V.on('parental', function () { if (/^#\/(live|radio|guide|channel)/.test(location.hash)) V.router.refresh(); });

  return {
    open: function (it) { return !lockedOf(it) || isOpen(); },
    locked: lockedOf,
    until: function () { return until; },
    unlock: function (it) { return ask(it); },
    lock: function () { V.api('/api/parental/lock', { method: 'POST' }).catch(function () {}); close(); },
  };
})();
