/* Guest (Admin → Profiles): a "Guest" on "Who's watching?" for visitors. Nothing it watches, likes or lists is kept
   (the server holds it in memory until the guest leaves), and none of it reaches anyone else's recommendations. Here:
   its button, picture, menu, and the things a guest can't do left out. */
'use strict';

(function () {
  var isGuest = function () { return !!(S.profile && S.profile.guest); };

  // Its picture: a plain person, not one of the household's avatars.
  var avatar = V.avatar;
  V.avatar = function (i, cls) {
    if (i === 'guest') return '<span class="avatar guest-av ' + (cls || '') + '">' + V.icon('user') + '</span>';
    return avatar(i, cls);
  };

  // "Who's watching?": the Guest button, just before "Add profile".
  var showProfiles = V.showProfiles;
  V.showProfiles = function () {
    showProfiles.apply(this, arguments);
    var g = S.boot && S.boot.guest;
    var add = V.$('#profiles [data-add]');
    if (!g || !add || S.boot.firstRun) return;
    var li = document.createElement('li');
    li.innerHTML = '<button class="pf pf-guest" data-id="guest" aria-label="Guest — nothing you watch is saved">' + V.avatar('guest', 'xl') + '<span class="pf-n">Guest</span>' + (g.kids ? '<span class="pf-kids">Kids</span>' : '') + '</button>';
    add.parentNode.parentNode.insertBefore(li, add.parentNode);
  };

  // (A guest isn't remembered as this device's last profile.)
  var select = V._selectProfile;
  V._selectProfile = function (id, pin) {
    var before = V.ls.get('lastProfile');
    return select.call(this, id, pin).then(function (x) { if (id === 'guest') V.ls.set('lastProfile', before); return x; });
  };

  // The top bar: marked as a guest; messages are for the household.
  var renderShell = V.renderShell;
  V.renderShell = function () {
    renderShell.apply(this, arguments);
    document.body.classList.toggle('guest', isGuest());
    if (isGuest() && V._guestSaid !== S.profile.id) {
      V._guestSaid = S.profile.id;
      V.toast('You’re watching as a guest — nothing you watch is saved, and it’s forgotten when you leave.', { ms: 6000 });
    }
  };

  // Its menu: what a guest can use, and "Leave" (which forgets everything from the visit).
  var profileMenu = V.profileMenu;
  V.profileMenu = function (btn) {
    if (!isGuest()) return profileMenu.apply(this, arguments);
    V.menu(btn, [
      { header: 'Guest — nothing is saved' },
      { label: 'Settings', icon: 'gear', fn: function () { V.router.go('#/settings'); } },
      { label: 'My List & history', icon: 'bookmark', hint: 'This visit', fn: function () { V.router.go('#/mine'); } },
      V.palette ? { label: 'Quick launcher', icon: 'search', hint: V.device.touch || V.tvMode ? '' : 'Ctrl+K', fn: function () { V.palette.open(); } } : null,
      { sep: true },
      { label: 'Leave guest', icon: 'users', hint: 'Forgets this visit', fn: function () { V.leaveProfile(); } },
      { label: 'Sign out of this device', icon: 'logout', fn: function () { V.confirm('Sign out of this device? You’ll need the site password to come back.', { ok: 'Sign out' }).then(function (ok) { if (ok) V.api('/api/logout', { method: 'POST' }).then(function () { location.replace('/'); }); }); } },
    ].filter(Boolean));
  };

  // Settings: the profile's own parts (name, picture, languages, privacy, removing it) aren't a guest's to change.
  var GONE = { 'Profile': 1, 'Languages': 1, 'Privacy': 1, 'Remove this profile': 1, 'Teams and competitions': 1 };
  V.on('route', function (r) {
    if (!r || !isGuest()) return;
    if (/^(wishlist|recordings|messages)$/.test(r.name)) { V.router.go('#/home'); return; }
    if (r.name !== 'settings') return;
    setTimeout(function () {
      var box = V.$('#view .settings');
      if (!box || V.$('.guest-note', box)) return;
      V.$$('.card-sec', box).forEach(function (s) { var h = V.$('h2', s); if (h && GONE[h.textContent.trim()]) s.remove(); });
      box.insertAdjacentHTML('afterbegin', '<p class="guest-note dim">You’re a guest: these settings last until you leave.</p>');
    }, 0);
  });
})();
