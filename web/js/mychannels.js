/* My channels: 24/7 channels made from the catalogue's films and series. Tuning in plays what's on now, from the
   right point, with the normal player, and moves on to the next item when it ends. Plus the Admin → My channels tab. */
'use strict';

/** Plays a 24/7 channel (its catalogue entry has the address "mych:<id>"). opts.at: a time to look up instead of now. */
V.mychPlay = function (ch, opts) {
  opts = opts || {};
  var id = String(ch.u).slice(5);
  return V.api('/api/mychannels/' + encodeURIComponent(id) + '/now' + (opts.at ? '?t=' + Math.round(opts.at) : '')).then(function (r) {
    if (!r.item) throw new Error('This channel has nothing to play right now.');
    var entry = V.entry(r.item.k) || r.item;
    var info = { id: id, ch: ch, name: r.channel.name, end: r.end, next: r.next };
    V.play(entry, { startAt: r.offset, mych: info, resume: false });
    // Say which channel this is, under the title (the player shows the film or episode's own name).
    var mark = function () { var sub = V.player && V.$('.vp-sub', V.player.host); if (sub && V.watch.mych === info && sub.textContent.indexOf(info.name) !== 0) sub.textContent = info.name + (sub.textContent ? ' · ' + sub.textContent : ''); };
    setTimeout(mark, 300); setTimeout(mark, 2500);
    var left = Math.max(0, Math.round((r.end - Date.now()) / 60000));
    if (V.player && V.player.osd) V.player.osd(r.channel.name + ' · ' + (entry.n || '') + (r.next ? ' · next: ' + (r.next.n || '') + (left ? ' in ' + left + ' min' : '') : ''), 5000);
  }).catch(V.fail);
};

/** The item on a channel ended: on to the next one (even if it ended before its slot did). */
V.mychNext = function () {
  var m = V.watch.mych;
  if (!m) return;
  V.mychPlay(m.ch, { at: Date.now() < m.end ? m.end + 1000 : 0 });
};

// ---------------------------------------------------------------- Admin → My channels
V.adminTabs.mychannels = function (body) {
  body.innerHTML = '<div class="spinner"></div>';
  var data = null;
  var draw = function () {
    var chans = data.channels;
    body.innerHTML = '<section class="card-sec"><h2>Your own 24/7 channels</h2><p class="dim">Make a channel from a category, a genre, a film series or titles you pick. It plays them one after another, all day, and shows in Live TV and the TV guide like any channel. Tuning in starts whatever is on at that moment. Nothing extra runs on the server.</p>' +
      '<div class="btn-row"><button class="btn primary" data-mc-add>' + V.icon('plus') + ' Make a channel</button></div></section>' +
      (chans.length ? '<ul class="mc-list">' + chans.map(function (c) {
        var what = c.source.type === 'titles' ? V.plural(c.source.keys.length, 'title') + ' you picked' : (c.source.type === 'category' ? 'Category' : c.source.type === 'genre' ? 'Genre' : 'Film series') + ': ' + V.esc(c.source.type === 'collection' ? V.mcColName(c.source.value) : c.source.value);
        return '<li class="card-sec mc-item" data-id="' + c.id + '"><img class="mc-logo" alt="" src="' + V.esc(c.logo || '/api/mychannels/' + c.id + '/logo.svg?v=' + c.builtAt) + '"><div class="mc-b"><b>' + V.esc(c.num ? c.num + ' · ' : '') + V.esc(c.name) + '</b>' + (c.enabled ? '' : ' <span class="chip sm">Off</span>') +
          '<div class="dim small">' + what + ' · ' + ({ order: 'in order', shuffle: 'shuffled', year: 'by year' })[c.order] + ' · ' + V.plural(c.count, 'programme') + ' · ' + c.hours + ' hours before it repeats</div>' +
          (c.now ? '<div class="small">' + V.icon('play', 'tiny') + ' Now: ' + V.esc(c.now) + '</div>' : '') +
          '<div class="btn-row"><button class="btn sm" data-mc-edit>' + V.icon('edit') + ' Edit</button><button class="btn sm" data-mc-shuffle>' + V.icon('refresh') + ' ' + (c.order === 'shuffle' ? 'Shuffle again' : 'Update') + '</button><button class="btn sm" data-mc-onoff>' + (c.enabled ? 'Turn off' : 'Turn on') + '</button><button class="btn sm danger" data-mc-del>' + V.icon('trash') + ' Delete</button></div></div></li>';
      }).join('') + '</ul>' : '<p class="dim">No channels yet.</p>') +
      '<p class="dim small">24/7 channels are played by this app (any device with it open). They aren’t in the playlist for other apps or the tuner, because those would need the server to stitch the programmes together.</p>';
  };
  V.mcColName = function (id) { var c = (data.options.collections || []).filter(function (x) { return String(x.id) === String(id); })[0]; return c ? c.name : 'Collection ' + id; };
  var load = function () { return V.api('/api/admin/mychannels').then(function (r) { data = r; draw(); }).catch(function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; }); };
  load();
  body.onclick = function (e) {
    if (e.target.closest('[data-mc-add]')) return V.mcDialog(null, data.options).then(function (ok) { if (ok) load(); });
    var li = e.target.closest('[data-id]');
    if (!li) return;
    var c = data.channels.filter(function (x) { return x.id === li.dataset.id; })[0];
    if (e.target.closest('[data-mc-edit]')) V.mcDialog(c, data.options).then(function (ok) { if (ok) load(); });
    else if (e.target.closest('[data-mc-shuffle]')) { V.toast('Updating “' + c.name + '”…'); V.put('/api/admin/mychannels/' + c.id, c.order === 'shuffle' ? { reshuffle: true } : { rebuild: true }).then(function () { V.toast('Done'); load(); }).catch(V.fail); }
    else if (e.target.closest('[data-mc-onoff]')) V.put('/api/admin/mychannels/' + c.id, { enabled: !c.enabled }).then(load).catch(V.fail);
    else if (e.target.closest('[data-mc-del]')) V.confirm('Delete the channel “' + c.name + '”?', { ok: 'Delete', danger: true }).then(function (ok) { if (ok) V.del('/api/admin/mychannels/' + c.id).then(load).catch(V.fail); });
  };
};

/** Make or edit a channel. Resolves true when saved. */
V.mcDialog = function (c, o) {
  var src = (c && c.source) || { type: 'category', kind: 'any' };
  var picked = (src.keys || []).map(function (k) { var it = V.entry(k); return { k: k, n: it ? it.n : k }; });
  var opt = function (v, l, cur) { return '<option value="' + V.esc(v) + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + V.esc(l) + '</option>'; };
  var catSel = function (kind) {
    return o.categories.filter(function (x) { return kind === 'any' || x.type === kind; }).map(function (x) { return opt(x.name, x.name + ' (' + (x.type === 'show' ? 'series' : 'films') + ', ' + x.n + ')', src.value); }).join('');
  };
  return V.dialog({
    title: c ? 'Edit “' + c.name + '”' : 'Make a channel', wide: true,
    body: '<form class="mc-form"><div class="grid2"><label class="field"><span>Name</span><input class="input" name="name" maxlength="60" value="' + V.esc(c ? c.name : '') + '" placeholder="Sitcoms 24/7"></label>' +
      '<label class="field"><span>Channel number</span><input class="input" name="num" type="number" min="1" max="99999" value="' + (c && c.num ? c.num : '') + '" placeholder="Automatic"></label></div>' +
      '<div class="grid2"><label class="field"><span>Plays</span><select class="input" name="type">' + opt('category', 'A category', src.type) + opt('genre', 'A genre', src.type) + (o.collections.length ? opt('collection', 'A film series (collection)', src.type) : '') + opt('titles', 'Titles I pick', src.type) + '</select></label>' +
      '<label class="field"><span>Films or series</span><select class="input" name="kind">' + opt('any', 'Both', src.kind) + opt('movie', 'Films only', src.kind) + opt('show', 'Series only', src.kind) + '</select></label></div>' +
      '<label class="field" data-for="category"><span>Category</span><select class="input" name="category"></select></label>' +
      '<label class="field" data-for="genre"><span>Genre</span><select class="input" name="genre">' + o.genres.map(function (g) { return opt(g.name, g.name + ' (' + g.n + ')', src.value); }).join('') + '</select>' + (o.genres.length ? '' : '<small class="dim">Genres come from TMDB or the provider; none are known yet.</small>') + '</label>' +
      '<label class="field" data-for="collection"><span>Film series</span><select class="input" name="collection">' + o.collections.map(function (x) { return opt(x.id, x.name + ' (' + x.n + ')', src.value); }).join('') + '</select></label>' +
      '<div class="field" data-for="titles"><span>Titles</span><input class="input" name="q" placeholder="Search films and series to add" autocomplete="off"><ul class="mc-results simple"></ul><div class="chips mc-picked"></div></div>' +
      '<div class="grid2"><label class="field"><span>Order</span><select class="input" name="order">' + opt('shuffle', 'Shuffled', (c && c.order) || 'shuffle') + opt('order', 'In order (A–Z, episodes in order)', c && c.order) + opt('year', 'Oldest first', c && c.order) + '</select></label>' +
      '<label class="field"><span>Group in Live TV</span><input class="input" name="group" maxlength="40" value="' + V.esc(c && c.group ? c.group : '') + '" placeholder="My channels"></label></div>' +
      '<label class="field"><span>Logo address (optional)</span><input class="input" name="logo" value="' + V.esc(c && c.logo ? c.logo : '') + '" placeholder="Leave empty for a picture made from its posters"></label>' +
      '<div class="err" role="alert"></div></form>',
    actions: [{ label: 'Cancel', value: false }, { label: c ? 'Save' : 'Make channel', primary: true, fn: function (d) {
      var f = V.$('form', d), fd = new FormData(f);
      var type = fd.get('type');
      var b = { name: fd.get('name'), num: fd.get('num'), order: fd.get('order'), group: fd.get('group'), logo: fd.get('logo'), source: { type: type, kind: fd.get('kind') } };
      if (type === 'titles') b.source.keys = picked.map(function (x) { return x.k; }); else b.source.value = fd.get(type);
      V.$('.err', d).textContent = 'Working out the running order… (series’ episodes may have to be fetched)';
      return (c ? V.put('/api/admin/mychannels/' + c.id, b) : V.api('/api/admin/mychannels', { body: b })).then(function (r) { V.toast((c ? 'Saved “' : 'Made “') + r.name + '” · ' + V.plural(r.count, 'programme')); return true; }, function (e) { V.$('.err', d).textContent = e.message; return false; });
    } }],
    onOpen: function (d) {
      var f = V.$('form', d);
      var show = function () {
        var t = f.type.value;
        V.$$('[data-for]', f).forEach(function (x) { x.hidden = x.dataset.for !== t; });
        f.category.innerHTML = catSel(f.kind.value);
      };
      var drawPicked = function () {
        V.$('.mc-picked', f).innerHTML = picked.map(function (x, i) { return '<button type="button" class="chip" data-unpick="' + i + '">' + V.esc(x.n) + ' ' + V.icon('x', 'tiny') + '</button>'; }).join('');
      };
      f.type.onchange = show; f.kind.onchange = show;
      show(); drawPicked();
      var t = null;
      f.q.oninput = function () {
        clearTimeout(t);
        t = setTimeout(function () {
          V.api('/api/admin/mychannels/titles?q=' + encodeURIComponent(f.q.value)).then(function (r) {
            V.$('.mc-results', f).innerHTML = r.map(function (x) { return '<li><button type="button" class="btn ghost block" data-pick="' + V.esc(x.k) + '" data-n="' + V.esc(x.n) + '">' + V.icon('plus', 'tiny') + ' ' + V.esc(x.n) + (x.y ? ' (' + x.y + ')' : '') + ' <span class="dim">· ' + (x.t === 'show' ? 'series' : 'film') + '</span></button></li>'; }).join('');
          }).catch(function () {});
        }, 250);
      };
      f.addEventListener('click', function (e) {
        var p = e.target.closest('[data-pick]');
        if (p) { if (!picked.some(function (x) { return x.k === p.dataset.pick; })) picked.push({ k: p.dataset.pick, n: p.dataset.n }); drawPicked(); }
        var u = e.target.closest('[data-unpick]');
        if (u) { picked.splice(+u.dataset.unpick, 1); drawPicked(); }
      });
    },
  });
};
