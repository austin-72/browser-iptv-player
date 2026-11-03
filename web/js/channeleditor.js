/* Admin → Channels: rename, re-logo, renumber, move, hide, reorder and lock channels; pick their guide and time offset.
   Admin → TV guides also gets a time offset per guide and the placeholder-listings switch. */
'use strict';
(V.adminExtraTabs = V.adminExtraTabs || []).push(['channels', 'Channels', 'lists']);

(function () {
  var OFFS = []; for (var h = -12; h <= 12; h += 0.5) OFFS.push(h);
  var fmtOff = function (h) { return !h ? 'No offset' : (h > 0 ? '+' : '−') + Math.abs(h) + ' h'; };
  var offOpts = function (cur) { return OFFS.map(function (h) { return '<option value="' + h + '"' + (h === (+cur || 0) ? ' selected' : '') + '>' + fmtOff(h) + '</option>'; }).join(''); };
  var cssq = function (s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); };
  var peekHtml = function (list) { return list && list.length ? list.map(function (p) { return '<span class="ce-peek-i"><b>' + V.fmtClock(p.s) + '</b> ' + V.esc(p.t) + '</span>'; }).join('') : '<span class="dim">No programmes in the next few hours.</span>'; };

  // Kept while the admin works here: the page is drawn again whenever the catalogue changes (each edit changes it).
  var mem = { st: { q: '', list: '', g: '', show: '', type: '', from: 0 }, sel: new Set(), focus: null, at: 0 };
  V.adminTabs.channels = function (body) {
    if (Date.now() - mem.at > 10 * 60e3) { mem.st = { q: '', list: '', g: '', show: '', type: '', from: 0 }; mem.sel = new Set(); }
    mem.at = Date.now();
    var st = mem.st;
    st.from = 0;
    var data = null, items = [], sel = mem.sel, last = -1;
    var groups = [];
    var load = function (more) {
      if (!more) { st.from = 0; items = []; }
      var qs = ['q', 'list', 'g', 'show', 'type'].map(function (k) { return k + '=' + encodeURIComponent(st[k]); }).join('&') + '&from=' + st.from + '&n=200';
      return V.api('/api/admin/channels?' + qs).then(function (r) {
        if (!body.isConnected) return; // (the page was drawn again meanwhile)
        data = r; groups = r.groups;
        items = more ? items.concat(r.items) : r.items;
        st.from = items.length;
        draw();
      }).catch(V.fail);
    };
    var row = function (c, i) {
      var badges = (c.hidden ? '<span class="chip sm">Hidden</span>' : '') + (c.locked ? '<span class="chip sm">' + V.icon('lock', 'tiny') + ' Locked</span>' : '') + (c.ov && !c.hidden ? '<span class="chip sm">Edited</span>' : '') + (c.off ? '<span class="chip sm">Guide ' + fmtOff(c.off) + '</span>' : '');
      var guide = c.hidden ? '' : c.epg ? (c.eo ? 'Guide: ' + V.esc(c.epg) + ' (picked)' : 'Guide: ' + V.esc(c.epg)) : '<span class="warn-t">No guide</span>';
      return '<li class="ce-row' + (sel.has(c.k) ? ' sel' : '') + (c.hidden ? ' off' : '') + '" data-k="' + V.esc(c.k) + '" data-i="' + i + '"' + (st.g && !c.hidden ? ' draggable="true"' : '') + '>' +
        '<label class="ce-chk"><input type="checkbox" data-pick' + (sel.has(c.k) ? ' checked' : '') + ' aria-label="Select ' + V.esc(c.n) + '"></label>' +
        '<span class="num ce-num">' + (c.num || '') + '</span>' + V.art(c.logo, c.n, 'art sm') +
        '<span class="ce-main"><b class="truncate">' + V.esc(c.n) + '</b>' + (c.n0 && c.n0 !== c.n ? '<small class="dim truncate">was “' + V.esc(c.n0) + '”</small>' : '') +
        '<small class="dim truncate">' + V.esc(c.g) + (c.srcName ? ' · ' + V.esc(c.srcName) : '') + (guide ? ' · ' + guide : '') + '</small>' + (badges ? '<span class="ce-badges">' + badges + '</span>' : '') + '</span>' +
        '<span class="ce-acts">' + (st.g && !c.hidden ? '<button class="icon-btn" data-mv="-1" aria-label="Move ' + V.esc(c.n) + ' up">' + V.icon('back', 'chev-up') + '</button><button class="icon-btn" data-mv="1" aria-label="Move ' + V.esc(c.n) + ' down">' + V.icon('back', 'chev-down') + '</button>' : '') +
        '<button class="btn sm" data-edit>' + V.icon('edit') + ' Edit</button></span></li>';
    };
    var draw = function () {
      var ae = document.activeElement;
      var keep = ae && ae.closest && ae.closest('[data-k]') ? [ae.closest('[data-k]').dataset.k, ae.getAttribute('data-mv') || (ae.hasAttribute('data-edit') ? 'edit' : '')] : null;
      // The search box, the filters and the other buttons up top keep the focus too (and what's typed so far), so
      // typing carries on and a remote isn't thrown back to the list.
      var tool = null;
      if (ae && !keep && body.contains(ae)) ['data-f', 'data-glock', 'data-pin', 'data-nopin', 'data-more', 'data-bulk'].forEach(function (n) { if (!tool && ae.hasAttribute(n)) tool = { sel: '[' + n + (ae.getAttribute(n) ? '="' + ae.getAttribute(n) + '"' : '') + ']', v: n === 'data-f' && ae.type === 'search' ? ae.value : null, at: ae.selectionStart }; });
      var pinOpen = !!(V.$('.ce-pin', body) && V.$('.ce-pin', body).open);
      var gl = st.g ? groups.filter(function (x) { return x.name === st.g; })[0] : null;
      body.innerHTML =
        '<details class="card-sec ce-pin"' + (pinOpen ? ' open' : '') + '><summary><b>' + V.icon('lock') + ' Parental lock</b> <span class="dim">' + (data && data.hasPin ? 'PIN set' : 'No PIN yet') + '</span></summary>' +
        '<p class="dim">Locked channels and categories ask for this PIN before they play, and what’s on them stays hidden until then. A device stays unlocked for 30 minutes. Kids profiles can’t unlock them.</p>' +
        '<div class="btn-row"><button class="btn" data-pin>' + (data && data.hasPin ? 'Change the parental PIN' : 'Set a parental PIN') + '</button>' + (data && data.hasPin ? '<button class="btn danger" data-nopin>Remove the PIN</button>' : '') + '</div>' +
        '<p class="small">Lock a whole category: pick it below and use “Lock this category”. Lock single channels with Edit, or select several and use Lock.</p></details>' +
        '<div class="page-tools ce-tools"><input class="input" type="search" data-f="q" value="' + V.esc(st.q) + '" placeholder="Find a channel or number" aria-label="Find a channel">' +
        '<select class="input" data-f="g" aria-label="Category"><option value="">All categories</option>' + groups.map(function (x) { return '<option value="' + V.esc(x.name) + '"' + (x.name === st.g ? ' selected' : '') + '>' + V.esc(x.name) + ' (' + x.n + ')' + (x.locked ? ' 🔒' : '') + '</option>'; }).join('') + '</select>' +
        '<select class="input" data-f="list" aria-label="List"><option value="">All lists</option>' + (data ? data.lists : []).map(function (l) { return '<option value="' + V.esc(l.id) + '"' + (l.id === st.list ? ' selected' : '') + '>' + V.esc(l.name) + '</option>'; }).join('') + '</select>' +
        '<select class="input" data-f="show" aria-label="Show"><option value="">Every channel</option><option value="changed"' + (st.show === 'changed' ? ' selected' : '') + '>Ones you changed' + (data && data.changed ? ' (' + data.changed + ')' : '') + '</option><option value="hidden"' + (st.show === 'hidden' ? ' selected' : '') + '>Hidden ones</option><option value="locked"' + (st.show === 'locked' ? ' selected' : '') + '>Locked ones</option><option value="noguide"' + (st.show === 'noguide' ? ' selected' : '') + '>Without a guide</option></select>' +
        '<select class="input" data-f="type" aria-label="Type"><option value="">TV and radio</option><option value="live"' + (st.type === 'live' ? ' selected' : '') + '>TV</option><option value="radio"' + (st.type === 'radio' ? ' selected' : '') + '>Radio</option></select></div>' +
        (gl ? '<div class="ce-gbar"><b>' + V.esc(gl.name) + '</b><span class="dim">' + V.plural(gl.n, 'channel') + ' · drag them, or use the arrows, to change their order</span><span class="sp"></span><label class="switch sm"><input type="checkbox" data-glock' + (gl.locked ? ' checked' : '') + '><span class="sw"></span><span>Lock this category</span></label></div>' : '') +
        '<div class="ce-bulk"' + (sel.size ? '' : ' hidden') + '><b>' + V.plural(sel.size, 'channel') + ' selected</b><button class="btn sm" data-bulk="hide">Hide</button><button class="btn sm" data-bulk="unhide">Show again</button><button class="btn sm" data-bulk="move">Move to…</button><button class="btn sm" data-bulk="renumber">Number from…</button><button class="btn sm" data-bulk="lock">' + V.icon('lock', 'tiny') + ' Lock</button><button class="btn sm" data-bulk="unlock">Unlock</button><button class="btn sm danger" data-bulk="reset">Undo changes</button><button class="btn sm ghost" data-bulk="none">Clear selection</button></div>' +
        (data ? '<p class="dim small">' + V.plural(data.total, 'channel') + (st.q || st.g || st.list || st.show || st.type ? ' match' : '') + '. Changes show on every device straight away.</p>' : '') +
        (items.length ? '<ul class="ce-list">' + items.map(row).join('') + '</ul>' : data ? V.empty('No channels here', st.show === 'hidden' ? 'Nothing is hidden.' : 'Try a different search or category.') : '<div class="spinner"></div>') +
        (data && items.length < data.total ? '<div class="btn-row"><button class="btn" data-more>Show more</button></div>' : '');
      var t = tool && (V.$(tool.sel, body) || (tool.sel === '[data-nopin]' && V.$('[data-pin]', body)));
      if (t && !t.closest('[hidden]')) {
        if (tool.v !== null) { t.value = tool.v; try { t.setSelectionRange(tool.at, tool.at); } catch (e) {} }
        t.focus({ preventScroll: true });
        keep = null;
      } else if (!keep && mem.focus && (!document.activeElement || document.activeElement === document.body)) keep = mem.focus;
      if (keep) { mem.focus = keep; var b = V.$('[data-k="' + cssq(keep[0]) + '"] ' + (keep[1] === 'edit' ? '[data-edit]' : keep[1] ? '[data-mv="' + keep[1] + '"]' : '[data-pick]'), body); if (b) b.focus({ preventScroll: false }); }
      mem.at = Date.now();
    };
    var byK = function (k) { return items.filter(function (x) { return x.k === k; })[0]; };
    var replace = function (c) { for (var i = 0; i < items.length; i++) if (items[i].k === c.k) { items[i] = Object.assign({ srcName: items[i].srcName }, c); } };
    var bulk = function (action, extra) {
      var keys = Array.from ? Array.from(sel) : (function () { var a = []; sel.forEach(function (k) { a.push(k); }); return a; })();
      return V.api('/api/admin/channels/bulk', { body: Object.assign({ keys: keys, action: action }, extra || {}) }).then(function (r) { V.toast(r.rebuild ? 'Saved — the channel list is being rebuilt' : 'Saved'); if (action !== 'lock' && action !== 'unlock') sel.clear(); setTimeout(load, r.rebuild ? 2500 : 0); }).catch(V.fail);
    };
    var order = function (k, d) {
      var list = items.filter(function (x) { return !x.hidden; });
      var i = list.map(function (x) { return x.k; }).indexOf(k), j = i + d;
      if (i < 0 || j < 0 || j >= list.length) return;
      list.splice(j, 0, list.splice(i, 1)[0]);
      return V.api('/api/admin/channels/bulk', { body: { action: 'order', keys: list.map(function (x) { return x.k; }) } }).then(function () { load(); }).catch(V.fail);
    };
    load();
    body.onchange = function (e) {
      var f = e.target.getAttribute('data-f');
      if (f && f !== 'q') { st[f] = e.target.value; sel.clear(); load(); return; }
      if (e.target.hasAttribute('data-glock')) { V.api('/api/admin/locks/toggle', { body: { kind: 'group', value: st.g, on: e.target.checked } }).then(function () { V.toast(e.target.checked ? 'Locked: ' + st.g : 'Unlocked: ' + st.g); load(); }).catch(V.fail); return; }
    };
    body.oninput = V.debounce(function (e) { if (e.target.getAttribute('data-f') === 'q') { st.q = e.target.value.trim(); load(); } }, 250);
    body.onclick = function (e) {
      var t = e.target, li = t.closest('[data-k]');
      if (t.closest('[data-more]')) return load(true);
      if (t.closest('[data-pin]')) return V.prompt(data && data.hasPin ? 'New parental PIN' : 'Parental PIN', { type: 'password', label: '4 to 8 digits', ok: 'Save' }).then(function (pin) { if (pin === null) return; V.put('/api/admin/parental-pin', { pin: pin }).then(function () { S.settings.parentalPin = true; V.toast('Parental PIN saved'); load(); }).catch(V.fail); });
      if (t.closest('[data-nopin]')) return V.confirm('Remove the parental PIN? Locked channels then can’t be unlocked until you set one again.', { ok: 'Remove', danger: true }).then(function (ok) { if (ok) V.put('/api/admin/parental-pin', { pin: '' }).then(function () { S.settings.parentalPin = false; load(); }).catch(V.fail); });
      var bb = t.closest('[data-bulk]');
      if (bb) {
        var a = bb.dataset.bulk;
        if (a === 'none') { sel.clear(); draw(); return; }
        if (a === 'move') return V.prompt('Move to which category?', { placeholder: 'A category name (new or existing)', ok: 'Move', value: st.g }).then(function (g) { if (g !== null) bulk('move', { g: g }); });
        if (a === 'renumber') return V.prompt('Number them from', { type: 'number', value: '1', ok: 'Number' }).then(function (n) { if (n) bulk('renumber', { from: +n }); });
        if (a === 'reset') return V.confirm('Undo your changes to ' + V.plural(sel.size, 'channel') + '?', { ok: 'Undo changes', danger: true }).then(function (ok) { if (ok) bulk('reset'); });
        return bulk(a);
      }
      if (!li) return;
      var c = byK(li.dataset.k);
      var mv = t.closest('[data-mv]');
      if (mv) return order(c.k, +mv.dataset.mv);
      if (t.closest('[data-edit]')) return V.channelEditDialog(c, groups).then(function (r) {
        if (!r) return;
        // (The page may have been drawn again while the dialog was open: that copy loads the change itself.)
        if (!body.isConnected) { V.router.refresh(); return; }
        if (r === 'reload') setTimeout(function () { load(); }, 2500); else { replace(r); draw(); }
      });
    };
    // Selecting: click a box; shift-click selects everything in between.
    body.addEventListener('click', function (e) {
      var box = e.target.closest('[data-pick]');
      if (!box) return;
      var li = box.closest('[data-k]'), i = +li.dataset.i;
      var on = box.checked;
      if (e.shiftKey && last >= 0) { var a = Math.min(last, i), b = Math.max(last, i); for (var x = a; x <= b; x++) { if (on) sel.add(items[x].k); else sel.delete(items[x].k); } }
      else if (on) sel.add(li.dataset.k); else sel.delete(li.dataset.k);
      last = i;
      draw();
    });
    body.addEventListener('focusin', function (e) { var r = e.target.closest && e.target.closest('[data-k]'); if (r) mem.focus = [r.dataset.k, e.target.getAttribute('data-mv') || (e.target.hasAttribute('data-edit') ? 'edit' : '')]; });
    // Desktop: drag a channel to a new place in its category.
    var dragK = null;
    body.addEventListener('dragstart', function (e) { var li = e.target.closest('.ce-row[draggable]'); if (!li) return; dragK = li.dataset.k; li.classList.add('dragging'); try { e.dataTransfer.setData('text/plain', dragK); e.dataTransfer.effectAllowed = 'move'; } catch (x) {} });
    body.addEventListener('dragover', function (e) { if (dragK && e.target.closest('.ce-row[draggable]')) e.preventDefault(); });
    body.addEventListener('drop', function (e) {
      var li = e.target.closest('.ce-row[draggable]');
      if (!dragK || !li) return;
      e.preventDefault();
      var list = items.filter(function (x) { return !x.hidden && x.k !== dragK; });
      var r = li.getBoundingClientRect();
      var at = list.map(function (x) { return x.k; }).indexOf(li.dataset.k) + (e.clientY > r.top + r.height / 2 ? 1 : 0);
      list.splice(at, 0, byK(dragK));
      dragK = null;
      V.api('/api/admin/channels/bulk', { body: { action: 'order', keys: list.map(function (x) { return x.k; }) } }).then(function () { load(); }).catch(V.fail);
    });
    body.addEventListener('dragend', function () { dragK = null; });
  };

  /** One channel's settings. Resolves to the updated channel, 'reload' (it will reappear after a rebuild) or null. */
  V.channelEditDialog = function (c, groups) {
    var st = { eo: c.eo || '', off: c.off || 0, logo: c.logo || '' };
    var body = '<div class="ce-dlg">' +
      '<div class="ce-dlg-top">' + V.art(st.logo, c.n, 'art ce-logo') + '<div><div class="dim small">' + V.esc(c.n0 && c.n0 !== c.n ? 'Provider’s name: ' + c.n0 : 'Channel ' + (c.num || '')) + '</div><b>' + V.esc(c.n) + '</b></div></div>' +
      '<div class="grid2"><label class="field"><span>Name</span><input class="input" data-v="n" value="' + V.esc(c.n) + '" placeholder="' + V.esc(c.n0 || '') + '" maxlength="120"></label>' +
      '<label class="field"><span>Number</span><input class="input" data-v="num" type="number" min="1" max="99999" value="' + (c.num || '') + '"></label>' +
      '<label class="field"><span>Category</span><input class="input" data-v="g" list="ce-groups" value="' + V.esc(c.g) + '" placeholder="' + V.esc(c.g0 || '') + '"></label>' +
      '<label class="field"><span>Logo (web address)</span><input class="input" data-v="logo" value="' + V.esc(st.logo.indexOf('data:') === 0 ? '' : st.logo) + '" placeholder="https://…/logo.png"></label></div>' +
      '<datalist id="ce-groups">' + (groups || []).slice(0, 3000).map(function (g) { return '<option value="' + V.esc(g.name) + '">'; }).join('') + '</datalist>' +
      '<div class="btn-row"><label class="btn sm"><input type="file" accept="image/*" data-upload hidden>' + V.icon('upload') + ' Upload a logo</label>' + (c.logo0 && c.logo0 !== st.logo ? '<button class="btn sm ghost" data-logo0>Use the provider’s logo</button>' : '') + '</div>' +
      '<h3>TV guide</h3><div class="ce-guide"><p class="small" data-gnow>' + (st.eo ? 'Using the guide channel <b>' + V.esc(st.eo) + '</b> (picked by hand).' : c.epg ? 'Matched automatically to <b>' + V.esc(c.epg) + '</b>.' : 'No guide matched automatically.') + '</p>' +
      '<div class="btn-row"><button class="btn sm" data-gpick>' + V.icon('search') + ' Pick a guide channel</button><button class="btn sm ghost" data-gauto' + (st.eo ? '' : ' hidden') + '>Back to automatic</button></div>' +
      '<label class="field"><span>Time offset for this channel</span><select class="input" data-v="off">' + offOpts(st.off) + '</select></label><div class="ce-peek small" data-peek></div></div>' +
      '<h3>More</h3><label class="check"><input type="checkbox" data-v="lock"' + (c.locked ? ' checked' : '') + '><span>Locked (asks for the parental PIN)</span></label>' +
      '<label class="check"><input type="checkbox" data-v="hide"' + (c.hidden ? ' checked' : '') + '><span>Hidden from everyone</span></label></div>';
    var peek = function (d) {
      var id = st.eo || c.epg;
      var box = V.$('[data-peek]', d);
      if (!id) { box.innerHTML = ''; return; }
      V.api('/api/admin/guide-peek?id=' + encodeURIComponent(id) + '&off=' + st.off).then(function (r) { box.innerHTML = '<span class="dim">Now and next with this offset:</span> ' + peekHtml(r.peek); }).catch(function () {});
    };
    return V.dialog({
      title: 'Edit channel', wide: true, body: body,
      actions: [
        c.ov ? { label: 'Undo all changes', danger: true, fn: function () { return V.del('/api/admin/channels/' + encodeURIComponent(c.k)).then(function (r) { V.toast('Back to the provider’s version'); return r.gone || c.hidden ? 'reload' : r; }); } } : null,
        { label: 'Cancel', value: null },
        { label: 'Save', primary: true, fn: function (d) {
          var v = function (k) { return V.$('[data-v="' + k + '"]', d); };
          // Only what changed: back to the provider's value clears it; the same as now leaves it alone.
          var patch = { eo: st.eo || null, off: +v('off').value || null, hide: v('hide').checked, lock: v('lock').checked };
          var field = function (f, val, orig, cur) { if (val === cur) return; patch[f] = !val || val === orig ? null : val; };
          field('n', v('n').value.trim(), c.n0 || c.n, c.n);
          field('g', v('g').value.trim(), c.g0 || c.g, c.g);
          field('num', +v('num').value || 0, -1, c.num || 0);
          var lg = v('logo').value.trim() || st.logo;
          field('logo', lg, c.logo0, c.logo);
          return V.put('/api/admin/channels/' + encodeURIComponent(c.k), patch).then(function (r) { V.toast(patch.hide && !c.hidden ? 'Hidden' : 'Saved'); return c.hidden && !patch.hide ? 'reload' : r; });
        } },
      ].filter(Boolean),
      onOpen: function (d) {
        peek(d);
        V.$('[data-v="off"]', d).onchange = function (e) { st.off = +e.target.value; peek(d); };
        var up = V.$('[data-upload]', d);
        up.onchange = function () {
          var f = up.files && up.files[0];
          if (!f) return;
          var img = new Image(), url = URL.createObjectURL(f);
          img.onload = function () {
            var s = Math.min(1, 256 / Math.max(img.width, img.height));
            var cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(img.width * s)); cv.height = Math.max(1, Math.round(img.height * s));
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            URL.revokeObjectURL(url);
            V.api('/api/admin/channels/logo', { body: { k: c.k, data: cv.toDataURL('image/png') } }).then(function (r) {
              st.logo = r.logo;
              V.$('[data-v="logo"]', d).value = '';
              var a = V.$('.ce-logo', d); a.outerHTML = V.art(r.logo, c.n, 'art ce-logo');
              V.toast('Logo uploaded — Save to use it');
            }).catch(V.fail);
          };
          img.onerror = function () { V.toast('That picture couldn’t be read.', { error: true }); };
          img.src = url;
        };
        V.$('[data-v="logo"]', d).addEventListener('change', function (e) { st.logo = e.target.value.trim() || (st.logo.indexOf('/api/channel-logo/') === 0 ? st.logo : c.logo0); });
        d.addEventListener('click', function (e) {
          if (e.target.closest('[data-logo0]')) { st.logo = c.logo0; V.$('[data-v="logo"]', d).value = c.logo0; var a = V.$('.ce-logo', d); a.outerHTML = V.art(c.logo0, c.n, 'art ce-logo'); }
          if (e.target.closest('[data-gauto]')) { st.eo = ''; V.$('[data-gnow]', d).innerHTML = 'Back to automatic matching (saved when you press Save).'; e.target.closest('[data-gauto]').hidden = true; peek(d); }
          if (e.target.closest('[data-gpick]')) V.guidePicker(c, st.off).then(function (id) { if (!id) return; st.eo = id; V.$('[data-gnow]', d).innerHTML = 'Using the guide channel <b>' + V.esc(id) + '</b> (saved when you press Save).'; V.$('[data-gauto]', d).hidden = false; peek(d); });
        });
      },
    });
  };

  /** Search the guides' channels; shows what's on each so the right one is easy to spot. Resolves to its id. */
  V.guidePicker = function (c, off) {
    return V.dialog({
      title: 'Pick a guide channel', wide: true,
      body: '<p class="dim">For “' + V.esc(c.n) + '”. Search by name or guide id; what’s on now is shown to help.</p><input class="input" type="search" data-gq value="' + V.esc((c.n0 || c.n).replace(/\b(HD|FHD|UHD|4K|SD)\b/gi, '').trim()) + '" aria-label="Search guide channels" autofocus><ul class="ce-gl"><li class="spinner"></li></ul>',
      actions: [{ label: 'Cancel', value: null }],
      onOpen: function (d, finish) {
        var run = function () {
          var q = V.$('[data-gq]', d).value.trim();
          V.api('/api/admin/guide-channels?q=' + encodeURIComponent(q) + '&off=' + (off || 0)).then(function (hits) {
            V.$('.ce-gl', d).innerHTML = hits.length ? hits.map(function (h) { return '<li><button class="ce-gi" data-id="' + V.esc(h.id) + '">' + V.art(h.icon, h.name, 'art sm') + '<span class="ce-main"><b class="truncate">' + V.esc(h.name) + '</b><small class="dim truncate">' + V.esc(h.id) + '</small><small class="truncate">' + peekHtml(h.peek.slice(0, 2)) + '</small></span></button></li>'; }).join('') : '<li class="dim">No guide channels match.</li>';
          }).catch(V.fail);
        };
        run();
        V.$('[data-gq]', d).addEventListener('input', V.debounce(run, 250));
        d.addEventListener('click', function (e) { var b = e.target.closest('[data-id]'); if (b) finish(b.dataset.id); });
      },
    });
  };

  // ------------------------------------------------------------ Admin → TV guides: offsets and placeholders
  var guidesTab = V.adminTabs.guides;
  V.adminTabs.guides = function (body, A) {
    guidesTab(body, A);
    V.api('/api/admin/guide-offsets').then(function (r) {
      var sec = document.createElement('section');
      sec.className = 'card-sec ce-gset';
      sec.innerHTML = '<label class="switch"><input type="checkbox" data-ph' + (r.placeholders ? ' checked' : '') + '><span class="sw"></span><span>Placeholder listings for channels with no guide <small class="dim">(hour-long blocks named after the channel, so the guide isn’t blank)</small></span></label>';
      body.insertBefore(sec, body.firstChild.nextSibling);
      V.$$('.adm-list [data-id]', body).forEach(function (li) {
        var id = li.dataset.id;
        var box = document.createElement('label');
        box.className = 'field ce-goff';
        box.innerHTML = '<span>Time offset</span><select class="input" data-goff>' + offOpts(r.offsets[id] || 0) + '</select>';
        li.appendChild(box);
      });
      sec.querySelector('[data-ph]').onchange = function (e) { V.put('/api/admin/epg-placeholders', { on: e.target.checked }).then(function () { S.settings.epgPlaceholders = e.target.checked; V.toast('Saved'); }).catch(V.fail); };
      body.addEventListener('change', function (e) {
        if (!e.target.hasAttribute('data-goff')) return;
        var li = e.target.closest('[data-id]');
        V.put('/api/admin/guides/' + li.dataset.id + '/offset', { hours: +e.target.value }).then(function (x) { V.toast(x.hours ? 'This guide’s times move ' + fmtOff(x.hours) : 'Offset removed'); V.epg.clear(); V.epg.load(); }).catch(V.fail);
      });
    }).catch(function () {});
  };
})();
