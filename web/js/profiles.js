/* "Who's watching?" — pick, add and set up profiles; PIN entry. */
'use strict';

V.INTERESTS = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Science Fiction', 'Thriller', 'War', 'Western', 'Reality', 'Sport', 'News', 'Kids'];

V.showProfiles = function () {
  var scr = V.$('#profiles');
  V.$('#shell').hidden = true;
  V.$('#player-layer').hidden = true;
  scr.hidden = false;
  document.body.classList.remove('watching', 'mini-playing');
  var b = S.boot;
  var brand = b.brand || {};
  document.title = brand.name || 'Who’s watching?';
  if (b.firstRun) {
    scr.innerHTML = '<div class="pf-wrap"><div class="pf-brand">' + V.esc(brand.name || '') + '</div><h1>Welcome</h1><p class="pf-lead">Create the first profile. It becomes the <b>admin</b> — the only one who can add playlists, change the site password and manage everyone’s profiles. It needs a PIN so nobody else can open the admin settings.</p><div class="pf-form"></div></div>';
    V.profileForm(V.$('.pf-form', scr), { first: true });
    return;
  }
  var last = V.ls.get('lastProfile');
  scr.innerHTML = '<div class="pf-wrap"><div class="pf-brand">' + V.esc(brand.name || '') + '</div><h1>Who’s watching?</h1><ul class="pf-grid" role="list">' +
    b.profiles.map(function (p) {
      return '<li><button class="pf" data-id="' + p.id + '"' + (p.id === last ? ' data-last' : '') + ' aria-label="' + V.esc(p.name) + (p.hasPin ? ', PIN protected' : '') + (p.kids ? ', kids profile' : '') + '">' + V.avatar(p.avatar, 'xl') + '<span class="pf-n">' + V.esc(p.name) + '</span>' +
        (p.hasPin ? '<span class="pf-lock">' + V.icon('lock') + '</span>' : '') + (p.kids ? '<span class="pf-kids">Kids</span>' : '') + (p.admin ? '<span class="pf-admin" title="Admin">' + V.icon('shield') + '</span>' : '') + '</button></li>';
    }).join('') +
    '<li><button class="pf add" data-add aria-label="Add a profile"><span class="avatar xl add-av">' + V.icon('plus') + '</span><span class="pf-n">Add profile</span></button></li></ul>' +
    '<div class="pf-foot"><button class="btn ghost" data-signout>' + V.icon('logout') + ' Sign out of this device</button></div></div>';
  scr.onclick = function (e) {
    var p = e.target.closest('[data-id]');
    if (p) return V.selectProfile(p.dataset.id);
    if (e.target.closest('[data-add]')) return V.addProfileDialog();
    if (e.target.closest('[data-signout]')) V.api('/api/logout', { method: 'POST' }).then(function () { location.replace('/'); });
  };
  var f = V.$('[data-last]', scr) || V.$('.pf', scr);
  if (f) setTimeout(function () { f.focus(); }, 30);
};

V.selectProfile = function (id, pin) {
  if (V._selecting) return V._selecting;
  V._selecting = V._selectProfile(id, pin);
  V._selecting.then(function () { V._selecting = null; }, function () { V._selecting = null; });
  return V._selecting;
};
V._selectProfile = function (id, pin) {
  var p = S.boot.profiles.filter(function (x) { return x.id === id; })[0];
  return V.api('/api/profiles/' + id + '/select', { body: pin === undefined ? {} : { pin: pin, remember: V.ls.get('pinRemember', true) }, allow401: true }).then(function () {
    V.ls.set('lastProfile', id);
    return V.enterApp();
  }, function (e) {
    if (e.status === 401 && p && p.hasPin) return V.pinPad(p).then(function (pin2) { if (pin2 !== null) return V._selectProfile(id, pin2); });
    if (e.status === 403 || e.status === 429) { V.toast(e.message, { error: true }); if (p && p.hasPin) return V.pinPad(p, e.message).then(function (pin3) { if (pin3 !== null) return V._selectProfile(id, pin3); }); }
    V.fail(e);
  });
};

/** A big number pad for PINs (works with a TV remote, a keyboard and touch). Resolves to the PIN or null. */
V.pinPad = function (p, error) {
  return V.dialog({
    title: 'Enter the PIN for ' + p.name, cls: 'pin-dlg',
    body: '<div class="pin-av">' + V.avatar(p.avatar, 'lg') + '</div><div class="pin-dots" aria-live="polite"></div>' + (error ? '<p class="err center">' + V.esc(error) + '</p>' : '') +
      '<input class="pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" aria-label="PIN" autofocus>' +
      '<label class="check pin-remember"><input type="checkbox" data-remember' + (V.ls.get('pinRemember', true) ? ' checked' : '') + '><span>Remember on this device</span></label>' +
      '<div class="pin-keys">' + [1, 2, 3, 4, 5, 6, 7, 8, 9, 'del', 0, 'ok'].map(function (k) { return '<button class="pin-k' + (k === 'ok' ? ' primary' : '') + '" data-k="' + k + '" aria-label="' + (k === 'del' ? 'Delete' : k === 'ok' ? 'OK' : k) + '">' + (k === 'del' ? V.icon('back') : k === 'ok' ? V.icon('check') : k) + '</button>'; }).join('') + '</div>',
    onOpen: function (d, finish) {
      var inp = V.$('.pin-input', d), dots = V.$('.pin-dots', d);
      var draw = function () { dots.innerHTML = Array.from({ length: Math.max(4, inp.value.length) }, function (_, i) { return '<i class="' + (i < inp.value.length ? 'on' : '') + '"></i>'; }).join(''); };
      draw();
      inp.addEventListener('input', function () { inp.value = inp.value.replace(/\D/g, '').slice(0, 8); draw(); });
      V.$('[data-remember]', d).addEventListener('change', function (e) { V.ls.set('pinRemember', e.target.checked); });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && inp.value.length >= 4) finish(inp.value); });
      d.addEventListener('click', function (e) {
        var b = e.target.closest('[data-k]');
        if (!b) return;
        var k = b.dataset.k;
        if (k === 'del') inp.value = inp.value.slice(0, -1);
        else if (k === 'ok') { if (inp.value.length >= 4) finish(inp.value); return; }
        else if (inp.value.length < 8) inp.value += k;
        draw();
        if (!V.device.touch) inp.focus();
      });
    },
  });
};

/**
 * Choose a picture. Resolves to an avatar number, or { upload: <JPEG data URL> } for a photo (when opts.upload),
 * or null.
 */
V.avatarPicker = function (current, opts) {
  opts = opts || {};
  var A = window.AVATARS;
  return V.dialog({
    title: 'Choose a picture', wide: true, cls: 'av-dlg',
    body: (opts.upload ? '<div class="av-upload"><label class="btn">' + V.icon('plus') + ' Use a photo<input type="file" accept="image/*" data-photo hidden></label><span class="dim small">or pick one below</span></div>' : '') +
      '<div class="tabs av-tabs" role="tablist">' + A.categories.map(function (c, i) { return '<button class="tab' + (i === 0 ? ' on' : '') + '" data-cat="' + i + '">' + V.esc(c.name) + '</button>'; }).join('') + '</div><div class="av-grid"></div>',
    onOpen: function (d, finish) {
      var grid = V.$('.av-grid', d);
      var show = function (ci) {
        var c = A.categories[ci];
        var html = '';
        for (var i = c.from; i <= c.to; i++) html += '<button class="av-pick' + (i === current ? ' on' : '') + '" data-av="' + i + '" title="' + V.esc(A.name(i)) + '" aria-label="' + V.esc(A.name(i)) + '">' + V.avatar(i, 'lg') + '</button>';
        grid.innerHTML = html;
        V.$$('[data-cat]', d).forEach(function (b) { b.classList.toggle('on', +b.dataset.cat === ci); });
      };
      var curCat = A.categories.findIndex(function (c) { return current >= c.from && current <= c.to; });
      show(curCat >= 0 ? curCat : 0);
      d.addEventListener('click', function (e) { var b = e.target.closest('[data-cat]'); if (b) show(+b.dataset.cat); var a = e.target.closest('[data-av]'); if (a) finish(+a.dataset.av); });
      var ph = V.$('[data-photo]', d);
      if (ph) ph.onchange = function () {
        var f = ph.files && ph.files[0];
        if (!f) return;
        V.squareImage(f, 320).then(function (url) { finish({ upload: url }); }).catch(function () { V.toast('That picture couldn’t be read. Try a JPG or PNG.', { error: true }); });
      };
    },
  });
};

/** The form for a new profile (also used for the very first, admin, profile). */
V.profileForm = function (host, o) {
  var A = window.AVATARS;
  var avatar = Math.floor(Math.random() * (A ? A.count : 1));
  var langs = S.boot.languages || [];
  var defaults = S.boot.defaultLangs || [];
  host.innerHTML = '<form class="pf-edit"><button type="button" class="pf-av-btn" data-av aria-label="Change picture">' + V.avatar(avatar, 'xl') + '<span class="pf-av-edit">' + V.icon('edit') + '</span></button>' +
    '<div class="pf-fields"><label class="field"><span>Name</span><input class="input" name="name" maxlength="24" required autocomplete="off" autofocus></label>' +
    '<label class="field"><span>PIN ' + (o.first ? '(required, 4–8 digits)' : '(optional, 4–8 digits)') + '</span><input class="input" name="pin" type="password" inputmode="numeric" pattern="\\d{4,8}" maxlength="8"' + (o.first ? ' required' : '') + ' autocomplete="new-password"></label>' +
    (o.first ? '' : '<label class="check"><input type="checkbox" name="kids"><span>Kids profile — only children’s titles and channels, with an age limit the admin can change</span></label>') +
    (langs.length ? '<details class="pf-more"><summary>Languages' + (defaults.length ? ' (default: ' + defaults.map(function (c) { var l = langs.filter(function (x) { return x.code === c; })[0]; return l ? l.name : c; }).join(', ') + ')' : '') + '</summary><p class="dim small">Only titles and channels in these languages are shown. Leave empty to use the default.</p><div class="lang-pick">' + V.langChecks([]) + '</div></details>' : '') +
    '<details class="pf-more"><summary>What do you like? (helps recommendations)</summary><div class="chips">' + V.INTERESTS.map(function (g) { return '<label class="chip-check"><input type="checkbox" name="interest" value="' + g + '"><span>' + g + '</span></label>'; }).join('') + '</div></details>' +
    '<div class="err" role="alert"></div><div class="btn-row">' + (o.first ? '' : '<button type="button" class="btn" data-cancel>Cancel</button>') + '<button class="btn primary">' + (o.first ? 'Create admin profile' : 'Add profile') + '</button></div></div></form>';
  var f = V.$('form', host);
  V.$('[data-av]', host).onclick = function () { V.avatarPicker(avatar).then(function (i) { if (i !== null && i !== undefined) { avatar = i; V.$('[data-av]', host).innerHTML = V.avatar(avatar, 'xl') + '<span class="pf-av-edit">' + V.icon('edit') + '</span>'; } }); };
  var cancel = V.$('[data-cancel]', host);
  if (cancel) cancel.onclick = function () { if (o.onCancel) o.onCancel(); };
  f.onsubmit = function (e) {
    e.preventDefault();
    var fd = new FormData(f);
    var body = { name: fd.get('name'), avatar: avatar, pin: fd.get('pin') || '', kids: !!fd.get('kids'), interests: fd.getAll('interest'), langs: V.$$('.lang-pick input:checked', host).map(function (x) { return x.value; }) };
    var btn = V.$('.btn.primary', f);
    btn.disabled = true;
    V.api('/api/profiles', { body: body }).then(function (p) {
      return V.api('/api/boot').then(function (b) {
        S.boot = b;
        if (o.first) { V.ls.set('lastProfile', p.id); return V.enterApp(); }
        if (o.onDone) o.onDone(p);
        V.showProfiles();
      });
    }).catch(function (err) { V.$('.err', f).textContent = err.message; btn.disabled = false; });
  };
};

V.langChecks = function (selected) {
  var langs = (S.boot && S.boot.languages) || [];
  var sel = new Set(selected || []);
  var common = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ar', 'tr', 'ru', 'pl', 'hi', 'ur', 'zh', 'ja', 'ko', 'sv', 'no', 'da', 'fi', 'el', 'ro', 'hu', 'cs', 'sr', 'hr', 'fa', 'he', 'vi', 'th', 'id'];
  var first = langs.filter(function (l) { return common.indexOf(l.code) >= 0 || sel.has(l.code); });
  var rest = langs.filter(function (l) { return common.indexOf(l.code) < 0 && !sel.has(l.code); });
  var box = function (l) { return '<label class="chip-check"><input type="checkbox" value="' + l.code + '"' + (sel.has(l.code) ? ' checked' : '') + '><span>' + V.esc(l.name) + (l.native && l.native !== l.name ? ' <small>' + V.esc(l.native) + '</small>' : '') + '</span></label>'; };
  return '<div class="chips">' + first.map(box).join('') + '</div>' + (rest.length ? '<details><summary class="small">More languages</summary><div class="chips">' + rest.map(box).join('') + '</div></details>' : '');
};

V.addProfileDialog = function () {
  var host = document.createElement('div');
  V.dialog({ title: 'Add a profile', body: host, wide: true, onOpen: function (d, finish) { V.profileForm(host, { onCancel: function () { finish(); }, onDone: function () { finish(); } }); } });
};

/** Back to “Who’s watching?”. lock: also forget this profile's PIN on this device. */
V.leaveProfile = function (lock) {
  if (V.watch && V.watch.it) V.closePlayer();
  V.rt.close();
  V.api('/api/profiles/leave', { body: { lock: !!lock } }).catch(function () {}).then(function () {
    S.profile = null; S.data = null; S.items = []; S.recs = null; S.socialCache = null; S.extra = new Map();
    V.epg.clear();
    return V.api('/api/boot');
  }).then(function (b) { S.boot = b; V.applyTheme(V.ls.get('theme', 'midnight')); V.showProfiles(); });
};

/** A file → a centred square JPEG data URL of size×size (photos are shrunk before they're sent). */
V.squareImage = function (file, size) {
  return new Promise(function (res, rej) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var side = Math.min(img.naturalWidth, img.naturalHeight);
      if (!side) { URL.revokeObjectURL(url); return rej(new Error('empty')); }
      var c = document.createElement('canvas'); c.width = size; c.height = size;
      var g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('unreadable')); };
    img.src = url;
  });
};
