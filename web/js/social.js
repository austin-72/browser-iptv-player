/* Messages between profiles (with shared titles and party invites) and watch parties with synced playback. */
'use strict';
V.REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🍿', '👀'];
V.profileById = function (id) { var s = S.socialCache; return s ? s.profiles.filter(function (p) { return p.id === id; })[0] || null : null; };

V.route('messages', function (view, r) {
  var conv = r.args[0] || '';
  var wide = window.innerWidth >= 860;
  view.innerHTML = '<div class="msg-page' + (conv ? ' has-conv' : '') + '"><aside class="convs"><h1>Messages</h1><div class="presence"></div><div class="conv-list"><div class="spinner"></div></div></aside><section class="thread" aria-live="polite"></section></div>';
  var listBox = V.$('.conv-list', view), thread = V.$('.thread', view);
  V.loadSharedLists().then(function (soc) {
    if (!document.contains(view)) return; // (another page by now: nothing to draw, and its clean-up isn't ours)
    var drawList = function () {
      var convs = soc.conversations;
      var byId = {};
      convs.forEach(function (c) { byId[c.id] = c; });
      var entries = [{ id: 'all', name: 'Everyone', all: true }].concat(soc.profiles.filter(function (p) { return p.id !== S.profile.id; }));
      entries.sort(function (a, b) { var x = byId[a.id], y = byId[b.id]; return (y ? y.last.at : 0) - (x ? x.last.at : 0); });
      // Alerts (new episodes, wishlist arrivals) sit at the top: homelists.js.
      var alertsRow = V.alertsThread ? '<a class="conv' + (conv === 'alerts' ? ' on' : '') + '" href="#/messages/alerts"><span class="avatar sm all">' + V.icon('bell') + '</span><span class="conv-b"><b class="truncate">New for you</b><span class="truncate dim">' + V.esc(V.alertsPreview()) + '</span></span>' + (S.alertsUnread ? '<span class="badge-n">' + S.alertsUnread + '</span>' : '') + '</a>' : '';
      listBox.innerHTML = alertsRow + entries.map(function (p) {
        var c = byId[p.id];
        var last = c ? c.last : null;
        var preview = last ? (last.from === S.profile.id ? 'You: ' : '') + (last.party ? 'Watch party invite' : last.item ? 'Sent “' + last.item.n + '”' : last.text) : p.all ? 'The household chat' : 'Say hi';
        return '<a class="conv' + (p.id === conv ? ' on' : '') + '" href="#/messages/' + p.id + '">' + (p.all ? '<span class="avatar sm all">' + V.icon('users') + '</span>' : V.avatar(p.avatar, 'sm') + (p.online ? '<i class="online" title="Online"></i>' : '')) +
          '<span class="conv-b"><b class="truncate">' + V.esc(p.name) + '</b><span class="truncate dim">' + V.esc(preview) + '</span></span>' + (c && c.unread ? '<span class="badge-n">' + c.unread + '</span>' : last ? '<small class="dim">' + V.fmtAgo(last.at) + '</small>' : '') + '</a>';
      }).join('');
      var pres = soc.presence || [];
      V.$('.presence', view).innerHTML = pres.length ? '<h2 class="small dim">Watching now</h2>' + pres.map(function (x) { var p = V.profileById(x.pid); return '<button class="pres" data-k="' + V.esc(x.k) + '">' + V.avatar(p ? p.avatar : 0, 'xs') + '<span class="truncate"><b>' + V.esc(p ? p.name : '') + '</b> ' + V.esc(x.n) + '</span></button>'; }).join('') : '';
    };
    drawList();
    V.$('.presence', view).onclick = function (e) { var b = e.target.closest('[data-k]'); if (b) { var it = V.entry(b.dataset.k); if (it) V.play(it); } };
    if (conv === 'alerts' && V.alertsThread) V.alertsThread(thread, drawList);
    else if (conv) openThread(conv, soc, drawList);
    else if (wide) thread.innerHTML = V.empty('Pick a conversation', 'Send messages, share what you’re watching, or start a watch party.');
    var offs = [
      V.on('message', function (m) { var c = m.to === 'all' ? 'all' : m.from === S.profile.id ? m.to : m.from; var cv = soc.conversations.filter(function (x) { return x.id === c; })[0]; if (!cv) soc.conversations.push(cv = { id: c, unread: 0, count: 0 }); cv.last = m; if (c !== conv && m.from !== S.profile.id) cv.unread++; drawList(); }),
    ];
    // (Added to the conversation's own clean-up, which openThread has just set.)
    var prev = V.pageCleanup;
    V.pageCleanup = function () { offs.forEach(function (f) { f(); }); if (prev) prev(); };
  }).catch(function (e) { listBox.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });

  function openThread(id, soc, drawList) {
    var other = id === 'all' ? { name: 'Everyone', all: true } : V.profileById(id);
    if (!other) { thread.innerHTML = V.empty('Not found', ''); return; }
    thread.innerHTML = '<header class="th-h"><a class="icon-btn back-btn" href="#/messages" aria-label="Back">' + V.icon('back') + '</a>' + (other.all ? '<span class="avatar sm all">' + V.icon('users') + '</span>' : V.avatar(other.avatar, 'sm')) + '<h2>' + V.esc(other.name) + '</h2></header>' +
      '<div class="msgs" role="log"></div><form class="composer"><button type="button" class="icon-btn" data-attach aria-label="Share a title">' + V.icon('plus') + '</button><textarea class="input" rows="1" placeholder="Message" aria-label="Message" maxlength="2000"></textarea><button class="icon-btn primary" aria-label="Send">' + V.icon('send') + '</button></form>';
    var box = V.$('.msgs', thread), ta = V.$('textarea', thread);
    var msgs = [];
    var draw = function () {
      var lastDay = '';
      box.innerHTML = msgs.map(function (m) {
        var mine = m.from === S.profile.id;
        var p = V.profileById(m.from);
        var day = V.fmtDay(m.at);
        var sep = day !== lastDay ? '<div class="day-sep">' + V.esc(day) + '</div>' : '';
        lastDay = day;
        var item = '';
        if (m.item) {
          var it = V.entry(m.item.k);
          item = '<div class="msg-item">' + V.art(m.item.i, m.item.n, 'art') + '<div><b>' + V.esc(m.item.n) + '</b>' + (m.item.pos ? '<span class="dim"> · from ' + V.fmtDur(m.item.pos) + '</span>' : '') +
            '<div class="mi-acts">' + (m.party ? '<button class="btn sm primary" data-join="' + m.party + '">' + V.icon('party') + ' Join the party</button>' : it ? '<button class="btn sm primary" data-play="' + V.esc(it.k) + '" data-pos="' + (m.item.pos || 0) + '">' + V.icon('play') + ' Play</button><a class="btn sm" href="' + V.hrefOf(it) + '">Details</a>' : '<span class="dim">Not available on your profile</span>') + '</div></div></div>';
        }
        var reacts = Object.keys(m.reacts || {}).map(function (e) { var who = m.reacts[e]; return '<button class="react' + (who.indexOf(S.profile.id) >= 0 ? ' on' : '') + '" data-react="' + e + '" data-id="' + m.id + '">' + e + ' ' + who.length + '</button>'; }).join('');
        return sep + '<div class="msg' + (mine ? ' mine' : '') + '" data-id="' + m.id + '">' + (!mine && other.all ? V.avatar(p ? p.avatar : 0, 'xs') : '') + '<div class="bubble">' + (!mine && other.all ? '<div class="who">' + V.esc(p ? p.name : '') + '</div>' : '') + item + (m.text ? '<div class="txt">' + V.esc(m.text).replace(/\n/g, '<br>') + '</div>' : '') +
          '<div class="msg-meta"><time>' + V.fmtClock(m.at) + '</time><button class="icon-btn xs" data-more="' + m.id + '" aria-label="React or delete">' + V.icon('smile') + '</button></div>' + (reacts ? '<div class="reacts">' + reacts + '</div>' : '') + '</div></div>';
      }).join('') || '<p class="dim center">No messages yet.</p>';
      box.scrollTop = box.scrollHeight;
    };
    V.api('/api/messages/' + id).then(function (list) { msgs = list; draw(); V.api('/api/messages/' + id + '/read', { method: 'POST' }).then(function () { V.loadSharedLists().then(function (s) { soc.conversations = s.conversations; drawList(); }); }); }).catch(V.fail);
    var send = function (body) { return V.api('/api/messages', { body: Object.assign({ to: id }, body) }).catch(V.fail); };
    V.$('form', thread).onsubmit = function (e) { e.preventDefault(); var t = ta.value.trim(); if (!t) return; ta.value = ''; ta.style.height = ''; send({ text: t }); };
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); V.$('form', thread).requestSubmit ? V.$('form', thread).requestSubmit() : V.$('form', thread).onsubmit(e); } });
    ta.addEventListener('input', function () { ta.style.height = ''; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
    V.$('[data-attach]', thread).onclick = function () { V.pickItem('Share a title or channel').then(function (it) { if (it) send({ item: { k: it.k, n: it.n, t: it.t, i: it.i || (V.showOf(it) || {}).i || '' } }); }); };
    box.addEventListener('click', function (e) {
      var b;
      if ((b = e.target.closest('[data-play]'))) V.play(V.entry(b.dataset.play), { startAt: +b.dataset.pos || undefined });
      else if ((b = e.target.closest('[data-join]'))) V.party.join(b.dataset.join);
      else if ((b = e.target.closest('[data-react]'))) V.api('/api/messages-react', { body: { id: b.dataset.id, emoji: b.dataset.react } }).catch(V.fail);
      else if ((b = e.target.closest('[data-more]'))) {
        var m = msgs.filter(function (x) { return x.id === b.dataset.more; })[0];
        V.menu(b, V.REACTIONS.map(function (em) { return { label: em, fn: function () { V.api('/api/messages-react', { body: { id: m.id, emoji: em } }).catch(V.fail); } }; }).concat(m.from === S.profile.id || S.profile.admin ? [{ sep: true }, { label: 'Delete message', icon: 'trash', danger: true, fn: function () { V.del('/api/messages/' + m.id).catch(V.fail); } }] : []));
      }
    });
    var offs = [
      V.on('message', function (m) { var c = m.to === 'all' ? 'all' : m.from === S.profile.id ? m.to : m.from; if (c !== id) return; msgs.push(m); draw(); if (m.from !== S.profile.id) V.api('/api/messages/' + id + '/read', { method: 'POST' }).catch(function () {}); }),
      V.on('react', function (d) { var m = msgs.filter(function (x) { return x.id === d.id; })[0]; if (m) { m.reacts = d.reacts; draw(); } }),
      V.on('unsend', function (d) { msgs = msgs.filter(function (x) { return x.id !== d.id; }); draw(); }),
    ];
    var prev = V.pageCleanup;
    V.pageCleanup = function () { offs.forEach(function (f) { f(); }); if (prev) prev(); };
    if (!V.device.touch) ta.focus();
  }
});

/** A search dialog to pick a title or channel. */
V.pickItem = function (title) {
  return V.dialog({
    title: title, wide: true,
    body: '<input class="input" type="search" data-q placeholder="Search" autofocus><div class="pick-results"></div>',
    onOpen: function (d, finish) {
      var out = V.$('.pick-results', d);
      var run = function (q) {
        var list = q ? V.search.find(q, { limit: 40, episodes: true }) : (S.recs && S.recs.top || []).map(V.entry).filter(Boolean).slice(0, 20);
        out.innerHTML = list.map(function (it) { return '<button class="pick" data-k="' + V.esc(it.k) + '">' + V.art(it.i || (V.showOf(it) || {}).i, it.n, 'art sm') + '<span class="truncate">' + V.esc(it.n) + '</span><small class="dim">' + V.esc(V.TYPE_NAMES[it.t] || '') + '</small></button>'; }).join('');
      };
      run('');
      V.$('[data-q]', d).addEventListener('input', V.debounce(function (e) { run(e.target.value); }, 150));
      out.addEventListener('click', function (e) { var b = e.target.closest('[data-k]'); if (b) finish(V.entry(b.dataset.k)); });
    },
  });
};

// Incoming messages while elsewhere in the app.
V.on('message', function (m) {
  if (m.from === S.profile.id) return;
  if (m.item) { S.recentShares = [m].concat(S.recentShares || []).slice(0, 30); }
  if (document.body.dataset.page === 'messages') return;
  S.unread = (S.unread || 0) + 1;
  V.updateUnread();
  var p = V.profileById(m.from);
  var conv = m.to === 'all' ? 'all' : m.from;
  var text = (p ? p.name : 'Someone') + ': ' + (m.party ? 'invited you to a watch party' : m.item ? 'sent you “' + m.item.n + '”' : m.text);
  V.toast(text, { action: m.party ? { label: 'Join', fn: function () { V.party.join(m.party); } } : { label: 'Open', fn: function () { V.router.go('#/messages/' + conv); } }, ms: 9000 });
  try { if (window.Notification && Notification.permission === 'granted' && document.hidden) new Notification(text); } catch (e) {}
});
V.on('read', function () { V.api('/api/social').then(function (s) { S.socialCache = s; S.unread = s.unread; V.updateUnread(); }).catch(function () {}); });

// ---------------------------------------------------------------- watch parties
V.party = (function () {
  var cur = null; // party view
  var applying = false;
  var hb = null;
  var me = function () { return S.profile.id; };
  var target = function (st) { return st.pos + (st.playing ? (Date.now() - st.at) / 1000 * (st.rate || 1) : 0); };

  function startDialog(it) {
    if (!it) return;
    // (Whether the provider limits connections decides if the party shares one by default.)
    var lim = V.api('/api/play/sources', { body: { k: it.k, origin: location.origin } }).then(function (r) { return ((r.sources || [])[0] || {}).limit || 0; }, function () { return 0; });
    Promise.all([V.api('/api/social'), lim]).then(function (rs) {
      var soc = rs[0], limit = rs[1];
      S.socialCache = soc;
      var others = soc.profiles.filter(function (p) { return p.id !== me(); });
      V.dialog({
        title: 'Watch “' + it.n + '” together',
        body: '<p class="dim">Everyone in the party sees the same thing at the same moment — play, pause and skipping stay in sync, with chat and reactions.</p>' +
          (others.length ? '<div class="pick-people">' + others.map(function (p) { return '<label class="person"><input type="checkbox" value="' + p.id + '"' + (p.online ? ' checked' : '') + '>' + V.avatar(p.avatar, 'sm') + '<span>' + V.esc(p.name) + (p.online ? ' <small class="ok">online</small>' : '') + '</span></label>'; }).join('') + '</div>' : '<p>There’s nobody else to invite yet.</p>') +
          '<label class="check"><input type="checkbox" data-host-only><span>Only I can pause and skip</span></label>' +
          '<label class="check"><input type="checkbox" data-share' + (limit > 0 ? ' checked' : '') + '><span>Share one connection <small class="dim">— the server fetches it once for everyone' + (limit > 0 ? ' (your provider allows ' + (limit === 1 ? 'one stream' : limit + ' streams') + ' at a time)' : '') + '</small></span></label>',
        actions: [{ label: 'Cancel' }, { label: 'Start the party', primary: true, fn: function (d) {
          var invite = V.$$('.person input:checked', d).map(function (x) { return x.value; });
          var hostOnly = V.$('[data-host-only]', d).checked;
          var share = V.$('[data-share]', d).checked;
          var pos = V.watch.it && V.watch.it.k === it.k && V.player.vod ? V.player.position : 0;
          return V.api('/api/party', { body: { k: it.k, n: it.n, t: it.t, i: it.i || (V.showOf(it) || {}).i || '', pos: pos, invite: invite, share: share } }).then(function (p) {
            if (hostOnly) V.api('/api/party/' + p.id + '/settings', { body: { hostOnly: true } }).catch(function () {});
            enter(p, true);
            V.toast(invite.length ? 'Invites sent' : 'Party started');
          });
        } }],
      });
    }).catch(V.fail);
  }

  function join(id) {
    V.api('/api/party/' + id + '/join', { method: 'POST' }).then(function (p) { enter(p, false); }).catch(V.fail);
  }

  function enter(p, host) {
    // Already in another party: leave it first (the server would go on counting you in it).
    if (cur && cur.id !== p.id) leave();
    cur = p;
    var it = V.entry(p.k);
    if (!it) { V.toast('That isn’t available on your profile', { error: true }); return leave(); }
    var st = p.state;
    V.play(it, { startAt: it.t === 'live' || it.t === 'radio' ? 0 : target(st), party: true, fromParty: true });
    document.body.classList.add('in-party');
    V.$('[data-a=party]', V.player.host).classList.add('on');
    if (!host && !st.playing && st.pos) setTimeout(function () { applying = true; V.player.video.pause(); applying = false; }, 1500);
    clearInterval(hb);
    hb = setInterval(function () { if (cur && cur.host === me() && V.player.started && !V.player.video.paused) send(true); }, 12000);
    setTimeout(function () { V.openSide('party'); }, 400);
  }

  function send(quiet) {
    if (!cur || applying) return;
    var p = V.player, it = V.watch.it;
    if (!it) return;
    V.api('/api/party/' + cur.id + '/state', { body: { playing: !p.video.paused, pos: p.vod ? p.position : 0, rate: p.video.playbackRate, k: it.k, n: it.n, t: it.t, i: it.i || '' } }).catch(function (e) { if (!quiet) V.fail(e); });
  }

  function changeItem(it) { if (cur && it) setTimeout(send, 800); }

  function apply(d) {
    if (!cur || d.party !== cur.id) return;
    var p = V.player;
    if (d.kind === 'state') {
      cur.state = d.state;
      if (d.state.by === me()) return;
      if (d.k !== (V.watch.it && V.watch.it.k)) { cur.k = d.k; var nit = V.entry(d.k); if (nit) V.play(nit, { startAt: target(d.state), fromParty: true }); return; }
      applying = true;
      try {
        if (p.vod) { var t = target(d.state); if (Math.abs(p.position - t) > 1.5) p.seek(t, true); }
        if (p.video.playbackRate !== d.state.rate) p.video.playbackRate = d.state.rate;
        if (d.state.playing && p.video.paused) p.video.play().catch(function () {});
        if (!d.state.playing && !p.video.paused) p.video.pause();
      } finally { setTimeout(function () { applying = false; }, 300); }
      var who = V.profileById(d.state.by);
      if (who) p.osd(who.name + (d.state.playing ? ' pressed play' : ' paused'), 1500);
    } else if (d.kind === 'chat') { cur.chat.push(d); drawChat(); if (V.watch.side !== 'party') { var w = V.profileById(d.who); p.osd((w ? w.name + ': ' : '') + d.text, 4000); } }
    else if (d.kind === 'emoji') floatEmoji(d.emoji);
    else if (d.kind === 'join') { if (cur.members.indexOf(d.who) < 0) cur.members.push(d.who); var j = V.profileById(d.who); if (j && d.who !== me()) V.toast(j.name + ' joined the party'); drawMembers(); if (cur.host === me()) setTimeout(send, 500); }
    else if (d.kind === 'leave') { cur.members = cur.members.filter(function (x) { return x !== d.who; }); cur.host = d.host; var l = V.profileById(d.who); if (l) V.toast(l.name + ' left the party'); drawMembers(); }
    else if (d.kind === 'settings') {
      cur.hostOnly = d.hostOnly;
      if (typeof d.share === 'boolean' && d.share !== !!cur.share) {
        cur.share = d.share;
        drawShare();
        V.toast(d.share ? 'The party now shares one connection' : 'Everyone now plays it from the provider themselves');
        // Start again the new way, at the same moment.
        var nowIt = V.watch.it, wasOpen = V.watch.side === 'party';
        if (nowIt) V.play(nowIt, { startAt: p.vod ? p.position : 0, fromParty: true });
        if (nowIt && wasOpen) setTimeout(function () { if (V.watch.side !== 'party') V.openSide('party'); }, 400);
      }
    }
  }

  function floatEmoji(e) {
    var box = V.$('.vp-react', V.player.host);
    var s = document.createElement('span');
    s.textContent = e;
    s.style.left = (10 + Math.random() * 80) + '%';
    box.appendChild(s);
    setTimeout(function () { s.remove(); }, 3000);
  }

  function renderSide(side, head) {
    if (!cur) { side.innerHTML = head('Watch party') + '<p class="dim">Not in a party.</p>'; return; }
    side.innerHTML = head('Watch party') + '<div class="party-members"></div><div class="party-chat" role="log"></div>' +
      '<div class="party-react">' + V.REACTIONS.map(function (e) { return '<button class="react-btn" data-emoji="' + e + '" aria-label="React ' + e + '">' + e + '</button>'; }).join('') + '</div>' +
      '<form class="party-form"><input class="input" placeholder="Say something" maxlength="500" aria-label="Chat message"><button class="icon-btn" aria-label="Send">' + V.icon('send') + '</button></form>' +
      '<div class="party-share"></div>' +
      '<button class="btn block ghost" data-invite>' + V.icon('plus') + ' Invite more</button><button class="btn block danger" data-leave>Leave the party</button>';
    drawMembers(); drawChat(); drawShare();
    V.$('.party-form', side).onsubmit = function (e) { e.preventDefault(); var inp = V.$('input', side); var t = inp.value.trim(); if (!t) return; inp.value = ''; V.api('/api/party/' + cur.id + '/chat', { body: { text: t } }).catch(V.fail); };
    // The side panel element is reused, so replace (not add) our listener each time it's drawn.
    if (side._partyClick) side.removeEventListener('click', side._partyClick);
    side._partyClick = function (e) {
      var b;
      if ((b = e.target.closest('[data-emoji]'))) { e.stopPropagation(); V.api('/api/party/' + cur.id + '/chat', { body: { emoji: b.dataset.emoji } }).catch(V.fail); }
      else if (e.target.closest('[data-leave]')) { e.stopPropagation(); leave(); V.closeSide(); }
      else if (e.target.closest('[data-invite]')) { e.stopPropagation(); invite(); }
    };
    side.addEventListener('click', side._partyClick);
  }
  function drawMembers() {
    var box = V.$('.party-members', V.player.host);
    if (!box || !cur) return;
    box.innerHTML = cur.members.map(function (id) { var p = V.profileById(id); return p ? '<span class="pm" title="' + V.esc(p.name) + '">' + V.avatar(p.avatar, 'xs') + V.esc(p.name) + (id === cur.host ? ' <small class="dim">host</small>' : '') + '</span>' : ''; }).join('');
  }
  /** "Share one connection": the host can switch it; everyone sees whether it's on. */
  function drawShare() {
    var box = V.$('.party-share', V.player.host);
    if (!box || !cur) return;
    var host = cur.host === me();
    box.innerHTML = '<label class="check"><input type="checkbox" data-share' + (cur.share ? ' checked' : '') + (host ? '' : ' disabled') + '><span>Share one connection <small class="dim">' +
      (cur.share ? '— the server fetches it once and everyone watches from there' : '— everyone plays it from the provider') + '</small></span></label>';
    var cb = V.$('[data-share]', box);
    cb.onchange = function () { V.api('/api/party/' + cur.id + '/settings', { body: { share: cb.checked } }).catch(function (e) { cb.checked = !cb.checked; V.fail(e); }); };
  }
  function drawChat() {
    var box = V.$('.party-chat', V.player.host);
    if (!box || !cur) return;
    box.innerHTML = cur.chat.map(function (m) { var p = V.profileById(m.who); return '<div class="pc' + (m.who === me() ? ' mine' : '') + '"><b>' + V.esc(p ? p.name : '') + '</b> ' + V.esc(m.text) + '</div>'; }).join('') || '<p class="dim small">Chat with everyone in the party here.</p>';
    box.scrollTop = box.scrollHeight;
  }
  function invite() {
    var soc = S.socialCache;
    var others = soc ? soc.profiles.filter(function (p) { return cur.members.indexOf(p.id) < 0; }) : [];
    V.dialog({ title: 'Invite to the party', body: others.length ? '<div class="pick-people">' + others.map(function (p) { return '<label class="person"><input type="checkbox" value="' + p.id + '">' + V.avatar(p.avatar, 'sm') + '<span>' + V.esc(p.name) + '</span></label>'; }).join('') + '</div>' : '<p>Everyone’s already here.</p>',
      actions: [{ label: 'Cancel' }, { label: 'Invite', primary: true, fn: function (d) { return Promise.all(V.$$('input:checked', d).map(function (x) { return V.api('/api/messages', { body: { to: x.value, text: 'Join my watch party: ' + cur.n, party: cur.id, item: { k: cur.k, n: cur.n, t: cur.t, i: cur.i } } }); })).then(function () { V.toast('Invited'); }); } }] });
  }
  function leave() {
    if (!cur) return;
    var id = cur.id;
    cur = null;
    clearInterval(hb);
    document.body.classList.remove('in-party');
    var b = V.$('[data-a=party]', V.player.host); if (b) b.classList.remove('on');
    V.api('/api/party/' + id + '/leave', { method: 'POST' }).catch(function () {});
  }
  function leaveConfirm() { V.confirm('Leave the watch party?', { ok: 'Leave' }).then(function (ok) { if (ok) { leave(); V.closePlayer(); } }); }

  V.on('party', apply);
  return {
    startDialog: startDialog, join: join, leave: leave, leaveConfirm: leaveConfirm, renderSide: renderSide, changeItem: changeItem, send: send,
    get current() { return cur; },
    onUserAction: function () { if (cur && !applying) send(); },
  };
})();
