/* Integrations: subtitles found online (SubDL, Addic7ed, OpenSubtitles), playback health reports (for Admin → Overview),
   the connection speed test, and the admin's Integrations and "API & automations" pages. */
'use strict';
(function () {
  // ------------------------------------------------------------ subtitles found online
  var ext = function (p) { return p._extSubs || (p._extSubs = []); };
  var subUrl = function (p, url) { return url + (p.sessionId && p.offset ? (url.indexOf('?') < 0 ? '?' : '&') + 'offset=' + p.offset : ''); };

  /** Adds a fetched subtitle to the video and shows it (hidden: only puts it in the Subtitles menu). */
  V.addExtSub = function (p, url, label, lang, again, hidden) {
    var v = p.video;
    var list = ext(p).filter(function (x) { return x.el && x.el.parentNode === v; }); // (a reload took the old ones off)
    p._extSubs = list;
    // (Kept, so a reload — a jump in a converted stream, a new quality — puts it back with the times moved right.)
    if (!hidden) p._extKeep = { k: p.it && p.it.k, url: url, label: label, lang: lang };
    // (The same file at a new address — its timing was corrected — takes the old one's place.)
    var fileOf = function (u) { return String(u).split('?')[0]; };
    var have = list.filter(function (x) { return fileOf(x.url) === fileOf(url); })[0];
    if (have && (again || have.url !== url)) { if (p._extOn === have.url) p._extOn = null; have.el.remove(); list.splice(list.indexOf(have), 1); have = null; }
    if (!have) {
      var tr = document.createElement('track');
      tr.kind = 'subtitles';
      tr.label = label;
      tr.srclang = (lang || 'und').slice(0, 3);
      tr.src = subUrl(p, url);
      tr.setAttribute('data-ext', '1');
      v.appendChild(tr);
      have = { url: url, label: label, lang: lang, el: tr };
      list.push(have);
    }
    if (hidden) { if (have.el.track && have.el.track.mode === 'showing' && p._extOn !== url) have.el.track.mode = 'disabled'; if (p._menuRefresh) p._menuRefresh(); return; }
    if (p.hls && p.hls.subtitleTrack >= 0) p.hls.subtitleTrack = -1;
    setTimeout(function () {
      // (This very track — two fetched ones, or one inside the file, can carry the same name, and showed on top of each other.)
      for (var j = 0; j < v.textTracks.length; j++) v.textTracks[j].mode = (have.el.track ? v.textTracks[j] === have.el.track : v.textTracks[j].label === have.label) ? 'showing' : 'disabled';
      p._extOn = have.url;
      if (p._menuRefresh) p._menuRefresh();
    }, 60);
  };
  /** Fetched subtitles in the player's Subtitles menu, next to whatever the stream or file has. */
  V.extSubsInto = function (p, out) {
    var list = (p._extSubs || []).filter(function (x) { return x.el && x.el.parentNode === p.video; });
    p._extSubs = list;
    if (!list.length) return;
    var v = p.video;
    var hideExt = function () { list.forEach(function (x) { if (x.el.track) x.el.track.mode = 'disabled'; }); p._extOn = null; p._extKeep = null; };
    var items = out.subs ? out.subs.items.filter(function (x) { return !list.some(function (e) { return e.label === x.label; }); }).map(function (x) { var fn = x.fn; return { label: x.label, on: x.on && !p._extOn, fn: function () { hideExt(); fn(); } }; }) : [{ label: 'Off', on: !p._extOn, fn: hideExt }];
    list.forEach(function (e) {
      items.push({ label: e.label, on: p._extOn === e.url, fn: function () { for (var j = 0; j < v.textTracks.length; j++) v.textTracks[j].mode = (e.el.track ? v.textTracks[j] === e.el.track : v.textTracks[j].label === e.label) ? 'showing' : 'disabled'; p._extOn = e.url; p._extKeep = { k: p.it && p.it.k, url: e.url, label: e.label, lang: e.lang }; } });
    });
    out.subs = { value: p._extOn ? (list.filter(function (e) { return e.url === p._extOn; })[0] || {}).label : out.subs ? out.subs.value : 'Off', items: items };
  };

  var subLabel = function (lang, from) { return (V.langName(lang) || lang) + (from ? ' (' + from + ')' : ''); };
  var osLeft = function (q) { return q && q.remaining !== undefined && Date.now() - (q.at || 0) < 24 * 3600e3 ? q.remaining : null; };
  /** The video's whole length in seconds, when it is known for sure (not a stream still growing). */
  var durOf = function (p) {
    if (!p.vod || !p.video) return 0;
    // (From the video itself or the server's look inside the file — never the provider's own figure, which is often rounded.)
    var v = p.video.duration, d = p.sessionDuration || (isFinite(v) && v > 0 ? v + (p.base || 0) : 0);
    return d > 60 && isFinite(d) ? Math.round(d) : 0;
  };
  var tokenOf = function (url) { var m = /\/api\/opensubs\/file\/([0-9a-f]+)/i.exec(String(url || '')); return m ? m[1] : ''; };
  V.subDurOf = durOf;

  /* What the words in a subtitle listing mean (shown under the list). */
  var HELP = '<details class="os-help"><summary>What do these mean?</summary><dl>' +
    '<dt>Everything spoken</dt><dd>Every line of speech. What most people want.</dd>' +
    '<dt>With sounds described (SDH)</dt><dd>Every line of speech, plus sounds and who is talking — “[door slams]”, “MAN:”. Written for deaf and hard-of-hearing viewers. Sites also call these HI or CC.</dd>' +
    '<dt>Foreign-language parts only</dt><dd>Only the lines spoken in a language other than the film’s own, and signs on screen. In an English film with some Spanish in it, just the Spanish is translated. There are only a handful of lines, so it looks broken if you wanted everything. Sites call these “forced”.</dd>' +
    '<dt>Blu-ray · Streaming · TV broadcast · DVD</dt><dd>The kind of copy the timing was made for. Copies of the same kind usually match each other; a TV broadcast and a Blu-ray often don’t (a recap at the start, breaks cut out).</dd>' +
    '<dt>23.976 fps · 25 fps</dt><dd>The speed of that copy. 25 is a European TV or DVD copy, which runs 4% faster: on any other copy the subtitles slip further out the longer it plays.</dd>' +
    '<dt>Extended · Director’s cut · Unrated</dt><dd>A different edit of the film, with scenes added or taken out. Subtitles for one go wrong at the first changed scene of another.</dd>' +
    '<dt>Official text</dt><dd>Copied from the disc or streaming service, not typed by a fan. Usually the most accurate.</dd>' +
    '<dt>Read by machine from a disc</dt><dd>The disc’s subtitles are pictures; a program read them into text. Good timing, the odd typo (l for I).</dd>' +
    '<dt>Retimed</dt><dd>Someone else’s subtitles, moved to fit a particular copy.</dd>' +
    '<dt>Whole season</dt><dd>A zip of every episode; this episode’s file is picked out of it.</dd>' +
    '</dl></details>';
  var KINDS = [['', 'All'], ['full', 'Everything spoken'], ['sdh', 'With sounds described'], ['foreign', 'Foreign parts only']];
  var rowHtml = function (x, left) {
    var meta = [x.from, x.pack ? 'whole season' : '', x.downloads ? V.plural(x.downloads, 'download') : '', x.votes >= 2 ? 'rated ' + (Math.round(x.rating * 10) / 10) + '/10' : '', x.fromTrusted ? 'trusted uploader' : '', x.cached ? 'saved here' : x.costly ? 'uses 1 of today’s OpenSubtitles downloads' : ''].filter(Boolean).join(' · ');
    return '<li data-kind="' + V.esc(x.kind || 'full') + '"><button class="btn ghost block os-pick' + (x.bad ? ' os-bad' : '') + '" data-f="' + V.esc(x.id || x.fileId) + '" data-l="' + V.esc(x.lang) + '" data-s="' + V.esc(x.from || '') + '"' + (x.costly && left === 0 ? ' disabled' : '') + '>' +
      '<span class="os-top"><span class="os-head"><b>' + V.esc(V.langName(x.lang) || x.lang) + '</b> <span class="os-what os-k-' + V.esc(x.kind || 'full') + '">' + V.esc(x.what || (x.hi ? 'With sounds described (SDH)' : 'Everything spoken')) + '</span></span>' +
      (x.best ? '<span class="os-tag best">Best match</span>' : '') + (x.tags || []).map(function (t) { return '<span class="os-tag">' + V.esc(t) + '</span>'; }).join('') + '</span>' +
      (x.bad ? '<span class="os-line os-warnline">' + V.icon('info', 'tiny') + ' Probably not right: ' + V.esc(x.bad) + '.</span>' : '') +
      (x.warn || []).map(function (w) { return '<span class="os-line os-warnline">' + V.icon('info', 'tiny') + ' ' + V.esc(w) + '</span>'; }).join('') +
      '<span class="os-line os-rel" title="' + V.esc(x.name) + '">' + V.esc(x.name) + '</span>' +
      (x.note ? '<span class="os-line os-note">“' + V.esc(x.note) + '”</span>' : '') +
      '<small class="dim">' + meta + '</small></button></li>';
  };
  V.findSubtitles = function (p) {
    var it = p.it;
    if (!it) return;
    var body = document.createElement('div');
    body.innerHTML = '<p class="dim small os-intro">Found online, in your languages, best fit for this video first. Pick one to show it.</p><div class="os-list"><div class="spinner"></div></div><div class="os-gen"></div>';
    var genStop = V.subGenPanel ? V.subGenPanel(p, V.$('.os-gen', body)) : null;
    V.dialog({ title: 'Find subtitles', body: body, wide: true, actions: [{ label: 'Close' }], onClose: function () { if (genStop) genStop(); } });
    // (No online source set up, only subtitles made here: nothing to search.)
    if (!(S.settings.subtitles || S.settings.opensubtitles)) { V.$('.os-list', body).innerHTML = ''; V.$('p', body).textContent = 'No online subtitle source is set up on this server.'; return; }
    var dur = durOf(p);
    V.api('/api/opensubs/search?k=' + encodeURIComponent(it.k) + (dur ? '&dur=' + dur : '')).then(function (r) {
      var box = V.$('.os-list', body);
      if (!box) return;
      // (A source that couldn't search — SubDL with a bad key, or one that's down — is said, not left out silently.)
      var warn = (r.warnings || []).length ? '<p class="dim small os-warn">' + r.warnings.map(V.esc).join('<br>') + '</p>' : '';
      if (!r.list.length) { box.innerHTML = '<p>Nothing found for “' + V.esc(it.n) + '” in your languages.</p>' + warn; return; }
      var left = osLeft(r.quota);
      var anyCostly = r.list.some(function (x) { return x.costly; });
      var have = {};
      r.list.forEach(function (x) { have[x.kind || 'full'] = (have[x.kind || 'full'] || 0) + 1; });
      var kinds = KINDS.filter(function (k) { return !k[0] || have[k[0]]; });
      var chips = kinds.length > 2 ? '<div class="os-kinds" role="group" aria-label="Which kind of subtitles">' + kinds.map(function (k, i) { return '<button class="chip' + (i ? '' : ' on') + '" data-kind="' + k[0] + '" aria-pressed="' + (i ? 'false' : 'true') + '">' + k[1] + (k[0] ? ' <span class="dim">' + have[k[0]] + '</span>' : '') + '</button>'; }).join('') + '</div>' : '';
      var good = r.list.filter(function (x) { return !x.bad; }), bad = r.list.filter(function (x) { return x.bad; });
      box.innerHTML = chips + '<ul class="os-ul">' + good.map(function (x) { return rowHtml(x, left); }).join('') +
        (bad.length ? '<li class="os-sep" data-kind="">Probably not for this video</li>' + bad.map(function (x) { return rowHtml(x, left); }).join('') : '') + '</ul>' + warn +
        (anyCostly ? '<p class="dim small">' + (left !== null ? 'OpenSubtitles: ' + V.plural(left, 'download') + ' left today.' : 'OpenSubtitles allows only a few downloads a day.') + ' The others are free.</p>' : '') + HELP;
      box.onclick = function (e) {
        var c = e.target.closest('.os-kinds .chip');
        if (c) {
          V.$$('.os-kinds .chip', box).forEach(function (x) { var on = x === c; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
          var want = c.dataset.kind;
          V.$$('.os-ul > li', box).forEach(function (li) { li.hidden = !!want && li.dataset.kind !== want; });
          return;
        }
        var b = e.target.closest('.os-pick');
        if (!b || b.disabled) return;
        b.disabled = true;
        V.api('/api/opensubs/get', { body: { id: b.dataset.f, fileId: b.dataset.f, k: it.k, dur: dur } }).then(function (g) {
          V.addExtSub(p, g.url, subLabel(b.dataset.l, b.dataset.s), b.dataset.l);
          p._extAuto = null; // (picked by hand: never swapped for another automatically)
          var d = body.closest('dialog'); if (d && d._finish) d._finish(null);
          if (g.warn) V.toast('These may be the wrong subtitles. ' + g.warn, { ms: 9000 });
          else p.osd && p.osd(g.moved ? movedWords(g.moved) : 'Subtitles on', g.moved ? 3500 : 1200);
        }).catch(function (err) { b.disabled = false; V.fail(err); });
      };
      var first = V.$('.os-pick:not([disabled])', box); if (first) first.focus();
    }).catch(function (e) { var box = V.$('.os-list', body); if (box) box.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  };
  /** "{ secs, speed }" from the server's listening, as a line for the screen. */
  var movedWords = function (m) {
    if (!m) return 'Subtitles checked against the sound: in time';
    if (m.speed) return 'Subtitles re-timed to this copy’s speed';
    var s = Math.abs(m.secs);
    return 'Subtitles moved ' + (s >= 10 ? Math.round(s) : s.toFixed(1)) + ' s ' + (m.secs > 0 ? 'later' : 'earlier') + ' to match the sound';
  };

  // ------------------------------------------------------------ subtitles made from the film's sound (lib/subgen.js)
  var genLabel = function (lang) { return (lang ? V.langName(lang) || lang : 'Spoken language') + ' (made here)'; };
  /**
   * In "Find subtitles": have the server write subtitles from the sound, when it has a speech-to-text program and
   * the admin lets this profile ask. Returns what stops its checking (the dialog closed).
   */
  V.subGenPanel = function (p, box) {
    var it = p.it, timer = null, gone = false;
    if (!S.settings.subGen || !it || (it.t !== 'movie' && it.t !== 'episode')) return null;
    var mins = function (s) { return s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.round((s % 3600) / 60) + ' min' : Math.round(s / 60) + ' min'; };
    var draw = function (r) {
      if (gone) return;
      clearTimeout(timer);
      var busy = r.state === 'queued' || r.state === 'waiting' || r.state === 'audio' || r.state === 'writing';
      var what = { queued: r.ahead ? 'Waiting for ' + V.plural(r.ahead, 'other title') + ' to be done first.' : 'About to start.', waiting: 'Waiting for a free connection to the provider.', audio: 'Listening to it… ' + (r.secs ? mins(r.secs) + ' heard so far.' : ''), writing: 'Writing the subtitles… ' + (r.pct ? r.pct + '%' : '') }[r.state] || '';
      box.innerHTML = '<h3 class="os-gen-h">Made from the sound</h3>' +
        (r.state === 'done' ? '<button class="btn ghost block os-pick" data-gen-show><b>' + V.esc(genLabel(r.lang)) + '</b> <span class="dim small">written by this server from what’s said · timing and words won’t be perfect</span></button>' + (S.profile.admin ? '<button class="linkish small" data-gen-del>Delete these and start over</button>' : '')
          : busy ? '<p class="os-gen-st" role="status"><span class="spinner sm"></span> ' + V.esc(what) + ' <span class="dim small">You can close this and keep watching: a note arrives when they’re ready.</span></p>' + (r.mine || S.profile.admin ? '<button class="linkish small" data-gen-del>Stop</button>' : '')
            : !r.can ? '<p class="dim small">' + (S.settings.subGen === 'admin' ? 'The admin can have this server write subtitles from what’s said.' : '') + '</p>'
              : (r.state === 'failed' ? '<p class="err small">Last time it didn’t work: ' + V.esc(r.err || 'unknown') + '</p>' : '') + '<p class="dim small">Nothing that fits? This server can listen to the whole ' + (it.t === 'movie' ? 'film' : 'episode') + ' and write subtitles in the language spoken. It takes a while (often a quarter of the running time, more on a small server) and doesn’t change how anything plays.</p><button class="btn" data-gen-go>' + V.icon('cc') + ' Make subtitles from the sound</button>');
      if (busy) timer = setTimeout(load, 5000);
    };
    var load = function () { return V.api('/api/subgen?k=' + encodeURIComponent(it.k)).then(draw).catch(function () { if (!gone) box.innerHTML = ''; }); };
    box.onclick = function (e) {
      var b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.hasAttribute('data-gen-go')) { b.disabled = true; V.api('/api/subgen', { body: { k: it.k } }).then(draw).catch(function (er) { b.disabled = false; V.fail(er); }); }
      else if (b.hasAttribute('data-gen-del')) { b.disabled = true; V.del('/api/subgen?k=' + encodeURIComponent(it.k)).then(load).catch(function (er) { b.disabled = false; V.fail(er); }); }
      else if (b.hasAttribute('data-gen-show')) V.api('/api/subgen?k=' + encodeURIComponent(it.k)).then(function (r) {
        if (r.state !== 'done') return draw(r);
        V.addExtSub(p, r.url, genLabel(r.lang), r.lang || 'und');
        var d = box.closest('dialog'); if (d && d._finish) d._finish(null);
        p.osd && p.osd('Subtitles on', 1200);
      }).catch(V.fail);
    };
    load();
    return function () { gone = true; clearTimeout(timer); };
  };
  // Ones already made for this title are in its Subtitles menu from the start (not switched on by themselves).
  V.on('playing', function (it) {
    if (!it || (it.t !== 'movie' && it.t !== 'episode') || !S.settings.subGen) return;
    var p = V.player, tok = p.token;
    if (p._genAsked === it.k) return;
    p._genAsked = it.k;
    V.api('/api/subgen?k=' + encodeURIComponent(it.k)).then(function (r) {
      if (r.state === 'done' && p.token === tok && V.watch.it === it) V.addExtSub(p, r.url, genLabel(r.lang), r.lang || 'und', false, true);
    }).catch(function () {});
  });
  // (Just finished, while it's playing: there straight away.)
  V.on('subgen', function (d) {
    var p = V.player;
    if (!d || d.state !== 'done' || !p || !p.it || p.it.k !== d.k) return;
    p._genAsked = null;
    V.api('/api/subgen?k=' + encodeURIComponent(d.k)).then(function (r) { if (r.state === 'done' && p.it && p.it.k === d.k) V.addExtSub(p, r.url, genLabel(r.lang), r.lang || 'und', false, true); }).catch(function () {});
  });

  /** Does the player already have subtitles in this language (from the stream, the file, or fetched)? */
  var hasSubsIn = function (p, lang) {
    lang = String(lang || '').slice(0, 2).toLowerCase();
    var v = p.video, i;
    for (i = 0; i < v.textTracks.length; i++) if (String(v.textTracks[i].language || '').slice(0, 2).toLowerCase() === lang) return true;
    var hs = p.hls && p.hls.subtitleTracks ? p.hls.subtitleTracks : [];
    for (i = 0; i < hs.length; i++) if (String(hs[i].lang || '').slice(0, 2).toLowerCase() === lang) return true;
    var fs = (p._fileTracks && p._fileTracks.subs) || [];
    for (i = 0; i < fs.length; i++) if (String(fs[i].lang || '').slice(0, 2).toLowerCase() === lang) return true;
    return false;
  };
  /*
   * Fetching automatically: the free sources ~15 seconds in; if they have nothing, OpenSubtitles (which allows only a few
   * downloads a day) once it's been watched for 3 minutes — so channel-surfing and quick peeks don't use them up.
   */
  V.on('playing', function (it) {
    if (!it || (it.t !== 'movie' && it.t !== 'episode') || !(S.settings.subtitles || S.settings.opensubtitles) || !V.pref('autoFetchSubs')) return;
    var p = V.player, tok = p.token;
    var still = function () { return p.token === tok && V.watch.it === it; };
    var lang = function () { return (V.pref('subLang') || ((S.profile && S.profile.langs) || S.settings.defaultLangs || ['en'])[0] || 'en').slice(0, 2); };
    var wanted = function () {
      var cur = p._fileTracks && (p._fileTracks.audio || [])[p.audioTrack || 0];
      if (p._subsWanted && !p._subsWanted(cur && cur.lang)) return false;
      return !hasSubsIn(p, lang());
    };
    var tryFetch = function (costly) {
      return V.api('/api/opensubs/auto', { body: { k: it.k, lang: lang(), costly: costly, dur: durOf(p) } }).then(function (r) {
        if (r && r.url && still() && wanted()) {
          V.addExtSub(p, r.url, subLabel(r.lang, r.from), r.lang);
          p._extAuto = r.id || tokenOf(r.url); // (fetched without being asked: swapped for another if it turns out not to match)
          // (unsure: the only ones left are ones that didn't line up with the sound — better than none, and said.)
          p.osd && p.osd(r.unsure ? 'No better subtitles found: these may be out of time' : r.moved ? movedWords(r.moved) : 'Subtitles from ' + (r.from || 'online'), r.unsure || r.moved ? 3500 : 2000);
          return true;
        }
        return false;
      }).catch(function () { return false; });
    };
    p._subsAgain = function (costly) { return tryFetch(!!costly); };
    setTimeout(function () {
      if (!still() || !wanted()) return;
      tryFetch(false).then(function (got) {
        if (got) return;
        var waited = 0;
        var tick = setInterval(function () {
          if (!still()) { clearInterval(tick); return; }
          if (!p.video || p.video.paused) return; // counts time actually watched
          waited += 5;
          if (waited < 165) return;
          clearInterval(tick);
          if (wanted()) tryFetch(true);
        }, 5000);
      });
    }, 15000);
  });


  // ------------------------------------------------------------ wrong or mistimed subtitles
  var shownExt = function (p) { var l = (p._extSubs || []).filter(function (x) { return x.url === p._extOn && tokenOf(x.url); })[0]; return l || null; };
  var dropExt = function (p, e) { if (e.el) e.el.remove(); p._extSubs = (p._extSubs || []).filter(function (x) { return x !== e; }); if (p._extOn === e.url) p._extOn = null; if (p._extKeep && p._extKeep.url === e.url) p._extKeep = null; if (p._menuRefresh) p._menuRefresh(); };
  /** "These are the wrong subtitles": told to the server (never fetched for this title again), and the next best tried. */
  V.subsWrong = function (p) {
    var e = shownExt(p), it = p.it;
    if (!e || !it) return;
    V.api('/api/opensubs/bad', { body: { k: it.k, id: tokenOf(e.url) } }).then(function () {
      dropExt(p, e);
      p.osd && p.osd('Looking for other subtitles…', 4000);
      var lang = (e.lang || 'en').slice(0, 2);
      return V.api('/api/opensubs/auto', { body: { k: it.k, lang: lang, costly: true, dur: durOf(p) } }).then(function (r) {
        if (p.it !== it) return;
        if (r && r.url) { V.addExtSub(p, r.url, subLabel(r.lang, r.from), r.lang); p._extAuto = r.id || tokenOf(r.url); p.osd && p.osd(r.unsure ? 'The only others found may be out of time' : 'Other subtitles, from ' + (r.from || 'online'), 3000); }
        else { p.osd && p.osd('No other subtitles fit this video', 3000); V.findSubtitles(p); }
      });
    }).catch(V.fail);
  };
  /** "Fix timing by listening": the server lines the subtitles up with the sound; the outcome arrives as "subsync". */
  V.subsListen = function (p) {
    var e = shownExt(p), it = p.it;
    if (!e || !it) return;
    V.api('/api/opensubs/check', { body: { k: it.k, id: tokenOf(e.url), dur: durOf(p) } }).then(function () {
      p.osd && p.osd('Listening to the sound to line the subtitles up… about a minute', 6000);
    }).catch(V.fail);
  };
  V.on('subsync', function (d) {
    var p = V.player;
    if (!p || !p.it || !d || p.it.k !== d.k) return;
    var e = (p._extSubs || []).filter(function (x) { return tokenOf(x.url) === d.id; })[0];
    if (!e) return;
    var showing = p._extOn === e.url;
    if (d.state === 'ok') {
      if (d.url && d.url !== e.url) {
        // (Its times are right in the file now: a nudge made by hand would be added on top.)
        if (showing && p.subDelay && p.setSubDelay) p.setSubDelay(0);
        V.addExtSub(p, d.url, e.label, e.lang, true, !showing);
        if (showing && p.osd) p.osd(movedWords(d.moved), 4000);
      } else if (d.byHand && showing && p.osd) p.osd(movedWords(d.moved), 3500);
    } else if (d.state === 'mismatch') {
      if (!showing) return;
      if (p._extAuto === d.id && (p._extSwaps = (p._extSwaps || 0) + 1) <= 2) {
        dropExt(p, e);
        p.osd && p.osd('Those subtitles didn’t match this video. Trying others…', 4000);
        if (p._subsAgain) p._subsAgain(false).then(function (got) { if (!got && p.it && p.it.k === d.k && p.osd) p.osd('No subtitles found that match this video', 3000); });
      } else V.toast(d.cut ? 'These subtitles match in places but not others: they look made for a different cut of this.' : 'These subtitles don’t line up with this video’s sound: they look made for something else. Try another from Find subtitles.', { ms: 9000 });
    } else if (d.byHand && showing && p.osd) p.osd('Couldn’t tell from the sound (too much music or noise). Timing left as it was.', 5000);
  });
  /* In the subtitles menu, while subtitles fetched online are showing. */
  V.ccMenuExtras = (function (prev) {
    return function (p, main, pages) {
      if (prev) prev(p, main, pages);
      if (!shownExt(p) || !p.it || (S.profile && S.profile.guest)) return;
      main.push({ label: 'Wrong subtitles?', value: 'Try others', fn: function () { V.subsWrong(p); } });
    };
  })(V.ccMenuExtras);

  // ------------------------------------------------------------ playback health → Admin → Overview
  var health = { stalls: 0, stallMs: 0, since: 0, v: null };
  var watchVideo = function (v) {
    if (health.v === v) return;
    health.v = v;
    v.addEventListener('waiting', function () { if (V.watch.it && !v.seeking && v.currentTime > 0.5) { health.stalls++; health.since = Date.now(); } });
    v.addEventListener('playing', function () { if (health.since) { health.stallMs += Date.now() - health.since; health.since = 0; } });
  };
  V.playbackStats = function () {
    var p = V.player, v = p.video, a = p.attempt || {};
    var out = { route: a.helper ? 'helper' : a.via === 'browser' || p.mb ? 'browser' : a.via === 'direct' || a.via === 'split' ? 'direct' : a.via === 'relay' ? 'relay' : a.via === 'local' ? 'local' : a.via ? 'convert' : '', w: v.videoWidth || 0, h: v.videoHeight || 0 };
    // (Straight from the provider, or through the stream relay; and why the server carries it when it does.)
    if ((out.route === 'direct' || out.route === 'browser') && p.reachInfo && p.reachInfo.relay) out.sr = 1;
    if (out.route === 'convert' || out.route === 'relay') { try { out.why = p._routeReason(out.route); } catch (e) {} if (a.mode) out.mode = a.mode; }
    var b = v.buffered, ahead = 0;
    for (var i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) > v.currentTime) ahead = b.end(i) - v.currentTime;
    out.buf = Math.round(ahead * 10) / 10;
    if (p.hls) { var l = p.levels[p.hls.currentLevel] || p.levels[p.hls.loadLevel] || {}; out.br = Math.round((l.bitrate || 0) / 1000); out.bw = Math.round((p.hls.bandwidthEstimate || 0) / 1000); out.lvl = l.height ? l.height + 'p' : ''; }
    else if (p.mts) { var st = p.mts.statisticsInfo || {}; out.bw = st.speed ? Math.round(st.speed * 8) : 0; }
    else if (p.shaka) { try { var ss = p.shaka.getStats(); out.br = Math.round((ss.streamBandwidth || 0) / 1000); out.bw = Math.round((ss.estimatedBandwidth || 0) / 1000); } catch (e) {} }
    if (v.getVideoPlaybackQuality) { var q = v.getVideoPlaybackQuality(); out.dropped = q.droppedVideoFrames || 0; out.frames = q.totalVideoFrames || 0; }
    out.stalls = health.stalls; out.stallMs = health.stallMs + (health.since ? Date.now() - health.since : 0);
    health.stalls = 0; health.stallMs = 0; if (health.since) health.since = Date.now();
    return out;
  };
  setInterval(function () {
    if (!V.watch || !V.watch.it || !V.player || !S.conn || document.hidden && V.player.video.paused) return;
    watchVideo(V.player.video);
    if (V.player.video.paused && !health.stalls) return;
    V.api('/api/presence/stats', { body: { conn: S.conn, s: V.playbackStats() } }).catch(function () {});
  }, 10000);
  V.on('playing', function () { if (V.player) watchVideo(V.player.video); health.stalls = 0; health.stallMs = 0; health.since = 0; });

  // ------------------------------------------------------------ speed test
  var mbps = function (bytes, ms) { return Math.round(((bytes * 8) / Math.max(1, ms) / 1000) * 10) / 10; };
  var verdict = function (m) {
    if (!m) return { t: 'No result', c: 'err' };
    if (m >= 25) return { t: 'Great — fine even for 4K', c: 'ok' };
    if (m >= 12) return { t: 'Good for HD (1080p); may struggle with 4K', c: 'ok' };
    if (m >= 6) return { t: 'Fine for HD 720p; 1080p may stutter', c: '' };
    if (m >= 3) return { t: 'Enough for standard definition', c: 'warn' };
    return { t: 'Too slow for smooth video', c: 'err' };
  };
  /** Reads a response for up to `ms` (or `max` bytes) → { bytes, ms, ttfb }. */
  var readFor = function (url, opts, ms, max) {
    var ac = window.AbortController ? new AbortController() : null;
    var t0 = Date.now(), ttfb = 0, n = 0;
    var timer = setTimeout(function () { if (ac) ac.abort(); }, ms + 4000);
    return fetch(url, Object.assign({ cache: 'no-store', signal: ac ? ac.signal : undefined }, opts || {})).then(function (r) {
      ttfb = Date.now() - t0;
      if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
      if (!r.body || !r.body.getReader) return r.arrayBuffer().then(function (b) { n = b.byteLength; return { bytes: n, ms: Date.now() - t0 - ttfb, ttfb: ttfb, r: r }; });
      var rd = r.body.getReader(), t1 = Date.now();
      var step = function () {
        return rd.read().then(function (x) {
          if (!x.done) n += x.value.length;
          if (x.done || Date.now() - t1 > ms || n >= max) { try { if (ac) ac.abort(); } catch (e) {} return { bytes: n, ms: Date.now() - t1, ttfb: ttfb, r: r }; }
          return step();
        });
      };
      return step();
    }).then(function (x) { clearTimeout(timer); return x; }, function (e) { clearTimeout(timer); if (n && e && e.name === 'AbortError') return { bytes: n, ms: Date.now() - t0 - ttfb, ttfb: ttfb }; throw e; });
  };
  /** Straight from this device to the provider (works only when the provider lets web pages read it). */
  var directProbe = function (t) {
    var u = t.u;
    if (t.headers || (location.protocol === 'https:' && /^http:/i.test(u))) return Promise.reject(new Error('blocked'));
    if (/\.m3u8(\?|$)/i.test(u)) {
      var t0 = Date.now();
      var getText = function (url) { return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text().then(function (x) { return { text: x, url: r.url || url }; }); }); };
      var pick = function (pl) { var lines = pl.text.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(function (x) { return x && x.charAt(0) !== '#'; }); return lines.length ? new URL(lines[lines.length > 3 ? lines.length - 2 : 0], pl.url).href : ''; };
      return getText(u).then(function (pl) {
        var nx = pick(pl);
        if (!nx) throw new Error('empty');
        return /\.m3u8(\?|$)/i.test(nx) ? getText(nx).then(function (p2) { return pick(p2); }) : nx;
      }).then(function (seg) { var ttfb0 = Date.now() - t0; return readFor(seg, {}, 5000, 16e6).then(function (x) { x.ttfb = ttfb0; return x; }); });
    }
    return readFor(u, t.kind === 'movie' ? { headers: { Range: 'bytes=0-16777215' } } : {}, 5000, 16e6);
  };
  V.speedTest = function (opts) {
    opts = opts || {};
    var body = document.createElement('div');
    body.className = 'speedtest';
    body.innerHTML = '<p class="dim">Checks how fast this device reaches this server, and how fast it reaches your provider. It takes about 20 seconds.</p>' +
      '<label class="field"><span>Provider to test</span><select class="input" data-list><option value="">Loading…</option></select></label>' +
      '<dl class="kv st-res"></dl><p class="st-verdict"></p>';
    var res = function () { return V.$('.st-res', body); };
    var row = function (k, label, val) { var dl = res(); var el = V.$('[data-k="' + k + '"]', dl); if (!el) { dl.insertAdjacentHTML('beforeend', '<dt>' + V.esc(label) + '</dt><dd data-k="' + k + '"></dd>'); el = V.$('[data-k="' + k + '"]', dl); } el.innerHTML = val; };
    var targets = [];
    V.api('/api/speedtest/targets').then(function (t) {
      targets = t;
      var sel = V.$('[data-list]', body);
      sel.innerHTML = t.length ? t.map(function (x) { return '<option value="' + V.esc(x.id) + '">' + V.esc(x.name) + (x.busy ? ' (all connections in use)' : '') + '</option>'; }).join('') : '<option value="">No lists to test</option>';
      var cur = V.watch && V.watch.it ? V.watch.it.src : '';
      if (cur && t.some(function (x) { return x.id === cur; })) sel.value = cur;
    }).catch(function () {});
    var running = false;
    var run = function () {
      if (running) return false;
      running = true;
      res().innerHTML = '';
      V.$('.st-verdict', body).textContent = '';
      var out = {};
      var spin = '<span class="spinner sm"></span>';
      row('ping', 'Delay to this server', spin);
      var pings = [], i = 0;
      var ping = function () { var t0 = performance.now(); return V.api('/api/speedtest/ping').then(function () { pings.push(performance.now() - t0); i++; return i < 5 ? ping() : null; }); };
      return ping().then(function () {
        pings.sort(function (a, b) { return a - b; });
        out.ping = Math.round(pings[Math.floor(pings.length / 2)]);
        row('ping', 'Delay to this server', out.ping + ' ms');
        row('down', 'Download from this server', spin);
        return readFor('/api/speedtest/down?mb=2', {}, 3000, 2e6).then(function () { return readFor('/api/speedtest/down?mb=40', {}, 5000, 40e6); });
      }).then(function (x) {
        out.down = mbps(x.bytes, x.ms);
        row('down', 'Download from this server', out.down + ' Mbit/s');
        row('up', 'Upload to this server', spin);
        var size = /Mobi|Android|iPhone/i.test(navigator.userAgent) ? 4 : 10;
        var blob = new Blob([new Uint8Array(size * 1024 * 1024)]);
        var t0 = Date.now();
        return V.api('/api/speedtest/up', { body: blob, headers: { 'Content-Type': 'application/octet-stream' } }).then(function (r) { out.up = mbps(r.bytes, Date.now() - t0); row('up', 'Upload to this server', out.up + ' Mbit/s'); });
      }).then(function () {
        var id = V.$('[data-list]', body).value;
        var t = targets.filter(function (x) { return x.id === id; })[0];
        if (!t) return;
        row('prov', 'From ' + t.name, spin);
        if (t.busy) { row('prov', 'From ' + t.name, 'not tested — every connection is in use right now'); return; }
        // (A list behind the stream relay: this device mustn't contact the provider itself — the server measures.)
        return ((S.settings.relayLists || []).indexOf(t.id) >= 0 ? Promise.reject(new Error('relay')) : directProbe(t)).then(function (x) {
          out.prov = mbps(x.bytes, x.ms);
          row('prov', 'From ' + t.name + ' (straight to this device)', out.prov + ' Mbit/s · first byte after ' + x.ttfb + ' ms');
        }, function () {
          return V.api('/api/speedtest/provider', { body: { list: id } }).then(function (r) {
            if (!r.ok) { row('prov', 'From ' + t.name, V.esc(r.error || 'failed')); return; }
            out.prov = r.mbps;
            out.provByServer = true;
            row('prov', 'From ' + t.name + ' (measured by the server)', r.mbps + ' Mbit/s · first byte after ' + r.ttfb + ' ms');
          });
        });
      }).then(function () {
        var limit = Math.min(out.down || 0, out.prov === undefined ? Infinity : out.prov);
        var vd = verdict(limit === Infinity ? out.down : limit);
        V.$('.st-verdict', body).innerHTML = '<b class="' + vd.c + '">' + V.esc(vd.t) + '</b>' + (out.prov === undefined ? '<br><small class="dim">That’s from this server; the provider couldn’t be tested, so it may still be the slow part.</small>' : '') + (out.provByServer ? '<br><small class="dim">This provider doesn’t let web pages read its streams directly, so the server measured it. Streams from it may go through the server on this device.</small>' : '') +
          (out.prov !== undefined && out.prov < out.down / 2 ? '<br><small class="dim">The provider is the slow part, not your network.</small>' : out.down < 8 && out.ping > 150 ? '<br><small class="dim">This device is a long way from the server (or on a slow network).</small>' : '');
      }).catch(function (e) { V.$('.st-verdict', body).innerHTML = '<span class="err">' + V.esc(e.message) + '</span>'; }).then(function () { running = false; return false; });
    };
    V.dialog({ title: 'Test the connection', body: body, wide: true, actions: [{ label: 'Close' }, { label: 'Start', primary: true, fn: run }] });
  };

  // ------------------------------------------------------------ Settings: subtitles, connection test
  V.settingsExtra = function () {
    var pf = S.data.prefs;
    return ((S.settings.subtitles || S.settings.opensubtitles) ? '<section class="card-sec"><h2>Subtitles found online</h2>' +
        '<label class="switch"><input type="checkbox" data-pref="autoFetchSubs"' + (pf.autoFetchSubs ? ' checked' : '') + '><span class="sw"></span><span><b>Fetch subtitles automatically</b><small>When a film or episode has none in your language and you’d want them</small></span></label>' +
        '<p class="dim small">You can also pick some yourself while watching: the subtitles button → Find subtitles.</p></section>' : '') +
      '<section class="card-sec"><h2>Connection</h2><p class="dim">How fast this device reaches the server and your provider, and what that’s good for.</p><button class="btn" data-a="speedtest">' + V.icon('pulse') + ' Test my connection</button></section>';
  };
  V.settingsExtraBind = function (view) {
    var st = V.$('[data-a=speedtest]', view);
    if (st) st.addEventListener('click', function () { V.speedTest(); });
  };
  // ------------------------------------------------------------ Admin → Overview: watching now, live
  var fmtK = function (kbps) { return kbps >= 1000 ? (Math.round(kbps / 100) / 10) + ' Mbit/s' : kbps ? kbps + ' kbit/s' : '–'; };
  var ROUTE = { local: 'Your own file (from this server)', direct: 'Direct from the provider', browser: 'Converted in the browser', relay: 'Through this server', convert: 'Converted on this server', helper: 'Direct (helper)' };
  // Why this server carries a stream (Admin → Statistics has the same words).
  var WHY = { format: 'a format this device can’t play', picture: 'no picture the direct way', 'direct-failed': 'the direct way didn’t start', chosen: 'quality chosen by the viewer', headers: 'needs headers browsers can’t send', https: 'plain http on an https page', setting: 'admin setting', blocked: 'the provider blocks web players', library: 'your own file' };
  var routeText = function (s) {
    if (!s || !s.route) return '';
    if ((s.route === 'direct' || s.route === 'browser') && s.sr) return s.route === 'browser' ? 'Converted in the browser · through the stream relay' : 'Direct · through the stream relay';
    var t = ROUTE[s.route] || s.route;
    if (s.route === 'convert' && s.mode) t += ' (' + (s.mode === 'transcode' ? 'transcoding' : 'repackaging') + ')';
    if (WHY[s.why]) t += ' — ' + WHY[s.why];
    return t;
  };
  var acctState = function (l) {
    var a = l.account;
    if (!l.hasAccount) return { cls: '', label: 'Playlist link', note: 'No account details for this kind of list' };
    if (!a) return { cls: '', label: 'Not checked yet', note: '' };
    var days = a.expires ? Math.floor((a.expires - Date.now()) / 86400e3) : null;
    var st = String(a.status || '').toLowerCase();
    var bad = (st && st !== 'active') || (days !== null && days < 0);
    var cls = bad ? 'bad' : days !== null && days <= 14 ? 'warn' : a.error && !a.checkedAt ? 'warn' : 'ok';
    var bits = [];
    if (a.expires) bits.push((days < 0 ? 'expired ' : 'expires ') + new Date(a.expires).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + (days >= 0 ? ' (' + V.plural(days, 'day') + ')' : ''));
    if (a.trial) bits.push('trial');
    if (a.active !== '' && a.active !== undefined) bits.push('provider says ' + a.active + ' in use');
    if (a.checkedAt) bits.push('checked ' + V.fmtAgo(a.checkedAt));
    var note = bits.join(' · ');
    return { cls: cls, label: a.status ? a.status.charAt(0).toUpperCase() + a.status.slice(1) : a.error ? 'Couldn’t check' : '?', note: note.charAt(0).toUpperCase() + note.slice(1), error: a.error };
  };
  var viewerRow = function (r) {
    var s = r.stats;
    var chips = s ? [routeText(s), s.h ? s.h + 'p' : '', s.bitrate ? 'stream ' + fmtK(s.bitrate) : '', s.bandwidth ? 'connection ' + fmtK(s.bandwidth) : '', 'buffer ' + s.buffer + ' s',
      s.stalls ? V.plural(s.stalls, 'pause') + ' to load (' + s.stallSecs + ' s) in ' + V.plural(s.minutes, 'min') : '', s.droppedPct ? s.droppedPct + '% frames dropped' : ''].filter(Boolean) : [];
    return '<li class="pv-row"><span class="pv-dot ' + (s ? r.health : 'wait') + '" title="' + (s ? (r.health === 'good' ? 'Smooth' : r.health === 'fair' ? 'Some trouble' : 'Struggling') : 'Waiting for the first report') + '"></span>' +
      '<div class="pv-who"><div><b>' + V.esc(r.profile) + '</b> · ' + (r.hidden ? '<span class="dim">(private)</span>' : V.esc(r.n)) + ' <span class="dim">on ' + V.esc(r.device) + ' · ' + V.fmtAgo(r.at) + '</span></div>' +
      (s ? '<div class="aw-stats small"><span class="aw-h ' + r.health + '">' + (r.health === 'good' ? 'Smooth' : r.health === 'fair' ? 'Some trouble' : 'Struggling') + '</span>' + chips.map(function (x) { return '<span>' + V.esc(x) + '</span>'; }).join('') + '</div>' : '<div class="dim small">Waiting for the first report…</div>') + '</div>' +
      // (Removing someone: not a device at your own address — that would shut you out too.)
      (r.ip && !r.you ? '<button class="btn sm pv-kick" data-kick="' + V.esc(r.conn) + '" aria-label="Remove ' + V.esc(r.profile + ' on ' + r.device) + '">' + V.icon('shield') + ' Remove</button>' : '') + '</li>';
  };
  // How long someone's kept off (Remove): minutes; 0 = until let back in.
  var KICK_FOR = [[10, '10 minutes'], [60, '1 hour'], [360, '6 hours'], [1440, '1 day'], [10080, '1 week'], [43200, '30 days'], [0, 'Until I let them back in'], [-1, 'Another length…']];
  var UNITS = [[1, 'minutes'], [60, 'hours'], [1440, 'days'], [10080, 'weeks']];
  /** Remove a viewer: the length, a reason they'll see, signing the device out too. → a promise, settled when done. */
  var kickDialog = function (r) {
    var body = '<p>What <b>' + V.esc(r.profile) + '</b> is watching on <b>' + V.esc(r.device) + '</b> stops, and their address (<code>' + V.esc(r.ip) + '</code>) is turned away — any page, any device there — for as long as you choose.</p>' +
      // (A home-network or Docker address: often every device at home, or everyone through a proxy, shares it.)
      (r.local ? '<p class="note warn">' + V.icon('info') + ' <span>This is a local address (your home network, or Docker’s). Devices at home — or everyone who comes in through a proxy or tunnel — may all share it, and would all be turned away.</span></p>' : '') +
      (r.shared && r.shared.length ? '<p class="note warn">' + V.icon('info') + ' <span>Also at that address right now, and turned away with them: ' + V.esc(r.shared.join(', ')) + '.</span></p>' : '') +
      '<label class="field"><span>For</span><select class="input" data-kfor>' + KICK_FOR.map(function (o, i) { return '<option value="' + o[0] + '"' + (i === 1 ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
      '<div class="kick-other" hidden><label class="field"><span>How many</span><input class="input" type="number" min="1" max="9999" value="2" data-kn inputmode="numeric"></label>' +
      '<label class="field"><span>Of</span><select class="input" data-ku>' + UNITS.map(function (u, i) { return '<option value="' + u[0] + '"' + (i === 1 ? ' selected' : '') + '>' + u[1] + '</option>'; }).join('') + '</select></label></div>' +
      '<label class="field"><span>Reason <small class="dim">(optional — they’ll see it)</small></span><input class="input" data-kwhy maxlength="200" placeholder="e.g. Sharing the password"></label>' +
      '<label class="switch"><input type="checkbox" data-kout><span class="sw"></span><span><b>Sign this device out too</b><small>When the time’s up, it needs the site password to come back.</small></span></label>';
    return V.dialog({
      title: 'Remove ' + r.profile, body: body,
      onOpen: function (d) {
        var sel = V.$('[data-kfor]', d), other = V.$('.kick-other', d);
        sel.onchange = function () { other.hidden = sel.value !== '-1'; if (!other.hidden) V.$('[data-kn]', d).focus(); };
      },
      actions: [{ label: 'Cancel', value: null }, { label: 'Remove', danger: true, fn: function (d) {
        var v = +V.$('[data-kfor]', d).value;
        if (v === -1) {
          var n = Math.floor(+V.$('[data-kn]', d).value);
          if (!(n > 0)) { V.toast('Enter how long.', { error: true }); return false; }
          v = n * +V.$('[data-ku]', d).value;
        }
        return V.api('/api/admin/kick', { body: { conn: r.conn, minutes: v, reason: V.$('[data-kwhy]', d).value, signOut: V.$('[data-kout]', d).checked } }).then(function (res) {
          var b = res.ban;
          V.toast(r.profile + ' was removed' + (b.until ? ' until ' + new Date(b.until).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ' until you let them back in') + (res.devices > 1 ? ' (' + V.plural(res.devices, 'device') + ')' : '') + '.');
          return true;
        });
      } }],
    });
  };
  /** The addresses kept off now, each with when it ends and a button to let it back in. */
  var bansBlock = function (list) {
    if (!list || !list.length) return '';
    return '<article class="pv pv-bans"><header class="pv-h"><b class="pv-name">Removed</b><span class="sp"></span><span class="pv-conn">' + V.plural(list.length, 'address', 'addresses') + '</span></header><ul class="pv-list">' +
      list.map(function (b) {
        return '<li class="pv-row"><span class="pv-dot ban" aria-hidden="true"></span><div class="pv-who"><div><b>' + V.esc(b.who || 'Someone') + '</b>' + (b.device ? ' <span class="dim">on ' + V.esc(b.device) + '</span>' : '') + ' · <code>' + V.esc(b.ip) + '</code></div>' +
          '<div class="dim small">' + (b.until ? 'Back ' + V.esc(b.when) : 'Until you let them back in') + ' · removed ' + V.fmtAgo(b.at) + (b.reason ? ' · “' + V.esc(b.reason) + '”' : '') + '</div></div>' +
          '<button class="btn sm pv-kick" data-unban="' + V.esc(b.id) + '">Let back in</button></li>';
      }).join('') + '</ul></article>';
  };
  /** Admin → Overview: each provider with its account and connections, and who's watching from it — live. */
  V.adminWatching = function (sec) {
    if (!sec) return;
    var draw = function () {
      if (!document.body.contains(sec)) return;
      V.api('/api/admin/watching').then(function (w) {
        var byList = {};
        w.rows.forEach(function (r) { (byList[r.lid || ''] = byList[r.lid || ''] || []).push(r); });
        var cards = w.lists.map(function (l) {
          var st = acctState(l), rows = byList[l.id] || [];
          var limit = l.limit || 0, used = l.used || 0;
          var dots = limit && limit <= 12 ? '<span class="pv-dots" aria-hidden="true">' + Array.from({ length: limit }, function (_, i) { return '<i class="' + (i < used ? 'on' : '') + '"></i>'; }).join('') + '</span>' : '';
          return '<article class="pv' + (rows.length || used ? ' busy' : '') + '"><header class="pv-h"><b class="pv-name">' + V.esc(l.name) + '</b><span class="pv-st ' + st.cls + '">' + V.esc(st.label) + '</span><span class="sp"></span>' +
            '<span class="pv-conn' + (limit && used >= limit ? ' full' : '') + '">' + dots + (limit ? used + ' of ' + V.plural(limit, 'connection') : used ? V.plural(used, 'connection') + ' in use' : 'idle') + '</span></header>' +
            (st.note ? '<div class="pv-meta small dim">' + V.esc(st.note) + '</div>' : '') +
            (st.error ? '<div class="pv-meta small err">Last check: ' + V.esc(st.error) + '</div>' : '') +
            (rows.length ? '<ul class="pv-list">' + rows.map(viewerRow).join('') + '</ul>' : '') +
            (l.other && l.other.length ? '<div class="pv-meta small">' + l.other.map(function (o) { return V.esc((o.who ? o.who + ' · ' : '') + (o.device || '') + (o.n ? ': ' + o.n : '')); }).join('<br>') + '</div>' : '') +
            (!rows.length && !(l.other && l.other.length) ? '<div class="pv-none small dim">Nobody watching</div>' : '') + '</article>';
        });
        var loose = byList[''] || [];
        // (Lists that are gone or off, or one's own files: still shown, apart.)
        Object.keys(byList).forEach(function (k) { if (k && !w.lists.some(function (l) { return l.id === k; })) loose = loose.concat(byList[k]); });
        var html = '<div class="sec-h"><h2>Providers and watching now</h2><span class="sp"></span><div class="btn-row"><button class="btn sm" data-acct>' + V.icon('refresh') + ' Check accounts</button><button class="btn sm" data-a="speedtest">' + V.icon('pulse') + ' Test the connection</button></div></div>' +
          (w.rows.length ? '' : '<p class="dim small pv-quiet">Nobody is watching right now.</p>') +
          (cards.length ? '<div class="pv-grid">' + cards.join('') + '</div>' : '<p class="dim">No provider lists.</p>') +
          (loose.length ? '<article class="pv pv-loose"><header class="pv-h"><b class="pv-name">Not from a provider</b></header><ul class="pv-list">' + loose.map(viewerRow).join('') + '</ul></article>' : '') +
          bansBlock(w.bans);
        sec._rows = w.rows;
        // (Every 5 seconds: redraw only when something changed, and keep focus on the button — a TV remote is often on it.)
        if (html !== sec._html) {
          var fa = document.activeElement, had = fa && sec.contains(fa) ? (fa.hasAttribute('data-acct') ? '[data-acct]' : fa.hasAttribute('data-kick') ? '[data-kick="' + fa.getAttribute('data-kick') + '"]' : fa.hasAttribute('data-unban') ? '[data-unban="' + fa.getAttribute('data-unban') + '"]' : '[data-a=speedtest]') : '';
          sec._html = html;
          sec.innerHTML = html;
          if (had) try { V.$(had, sec).focus({ preventScroll: true }); } catch (e) {}
        }
        clearTimeout(sec._t);
        sec._t = setTimeout(draw, 5000);
      }).catch(function () { clearTimeout(sec._t); sec._t = setTimeout(draw, 15000); });
    };
    sec.onclick = function (e) {
      if (e.target.closest('[data-a=speedtest]')) V.speedTest({ admin: true });
      var kb = e.target.closest('[data-kick]');
      if (kb) {
        var r = (sec._rows || []).filter(function (x) { return x.conn === kb.getAttribute('data-kick'); })[0];
        if (r) kickDialog(r).then(function (ok) { if (ok) { sec._html = ''; clearTimeout(sec._t); draw(); } });
      }
      var ub = e.target.closest('[data-unban]');
      if (ub && !ub.disabled) {
        ub.disabled = true;
        V.api('/api/admin/bans/' + encodeURIComponent(ub.getAttribute('data-unban')), { method: 'DELETE' }).then(function () { V.toast('Let back in.'); sec._html = ''; clearTimeout(sec._t); draw(); }).catch(function (x) { ub.disabled = false; V.fail(x); });
      }
      var c = e.target.closest('[data-acct]');
      if (c && !c.disabled) {
        c.disabled = true;
        c.innerHTML = '<span class="spinner sm"></span> Checking…';
        V.api('/api/admin/accounts/check', { method: 'POST' }).then(function () { sec._html = ''; draw(); }).catch(V.fail);
      }
    };
    draw();
  };

  // ------------------------------------------------------------ Admin → Integrations
  var secretField = function (name, label, val, hint) { return '<label class="field"><span>' + label + '</span><input class="input" data-f="' + name + '" value="' + V.esc(val || '') + '" autocomplete="off" spellcheck="false">' + (hint ? '<small class="dim">' + hint + '</small>' : '') + '</label>'; };
  // (After a save reloads a tab: the button to put focus back on.)
  var focusBack = function (body, sel) {
    var el = null;
    try { el = sel && V.$(sel, body); } catch (e) {}
    if (el) try { el.focus({ preventScroll: true }); } catch (e) {}
  };
  V.adminTabs.integrations = function (body, A, refocus) {
    // (Reloading after a save: keep the page as it is until the new one is ready, rather than a spinner.)
    if (!refocus) body.innerHTML = '<div class="spinner"></div>';
    V.api('/api/admin/integrations').then(function (I) {
      var o = I.opensubtitles, sd = I.subdl || {}, src = I.sources || {};
      var left = o.quota && o.quota.remaining !== undefined ? '<p class="dim small">' + V.plural(o.quota.remaining, 'download') + ' left today (checked ' + V.fmtAgo(o.quota.at) + '). Fetching automatically leaves the last ' + (o.reserve || 2) + ' for choosing by hand.</p>' : '';
      body.innerHTML = '<section class="card-sec"><h2>Subtitles found online</h2><p class="dim">Lets anyone find subtitles for a film or episode that has none in their language (the subtitles button → Find subtitles), or fetch them automatically. Sources are searched together; the free ones are used first.</p>' +
        '<h3>SubDL <span class="dim small">· main source</span></h3><p class="dim small">Free: sign up at subdl.com, then your account → API key. 2,000 searches a day; downloads aren’t counted.</p>' +
        '<div class="int-fields">' + secretField('sd.apiKey', 'API key', sd.apiKey) + '</div>' +
        '<label class="switch"><input type="checkbox" data-src="gestdown"' + (src.gestdown !== false ? ' checked' : '') + '><span class="sw"></span><span><b>Addic7ed (through Gestdown)</b><small>Free, no key needed. TV episodes only — often the quickest after an episode airs.</small></span></label>' +
        '<div class="btn-row"><button class="btn primary" data-save="sd">Save</button><button class="btn" data-test="all">Test all sources</button></div><div class="all-test small"></div>' +
        '<h3>Checking them against the sound</h3><p class="dim small">Subtitles found online are often timed for another copy, or are for another episode. The server can listen to a few minutes of the film’s sound, line the subtitles up with the speech, move them if they are off, and drop ones that don’t match at all. Only the sound is read; nothing about how the film plays changes. Reading it from a provider uses one of that provider’s connections for about a minute.</p>' +
        (I.canListen ? '<label class="field"><span>Listen</span><select class="input" data-sub-listen>' + [['spare', 'When it costs no provider connection, or one is known to be free (recommended)'], ['always', 'Whenever the provider isn’t known to be full'], ['never', 'Never']].map(function (o) { return '<option value="' + o[0] + '"' + (I.subListen === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>'
          : '<p class="note">' + V.icon('info') + ' <span>This needs ffmpeg, which isn’t on this server.</span></p>') + '</section>' +
        '<section class="card-sec"><h2>Backup: OpenSubtitles.com</h2><p class="dim">The biggest library, used when the free sources have nothing. A free API key (opensubtitles.com → your profile → API consumers) allows 5 downloads a day, shared by everyone here; subtitles already saved here don’t count again. Signing in with an account only raises that with a VIP subscription.</p>' +
        '<div class="int-fields">' + secretField('os.apiKey', 'API key', o.apiKey) + secretField('os.username', 'Account username (optional)', o.username) + '<label class="field"><span>Account password</span><input class="input" type="password" data-f="os.password" value="' + V.esc(o.password) + '" autocomplete="new-password"></label></div>' +
        left +
        '<div class="btn-row"><button class="btn primary" data-save="os">Save</button><button class="btn" data-test="os">Test</button></div><p class="os-test small"></p></section>' +
        '<section class="card-sec" data-subgen><h2>Subtitles made from the sound</h2><div class="spinner"></div></section>';
      focusBack(body, refocus);
      // Subtitles written by the server from what's said (lib/subgen.js): what was found, and who may ask.
      var drawGen = function (g) {
        var sec = V.$('[data-subgen]', body);
        if (!sec) return;
        sec.innerHTML = '<h2>Subtitles made from the sound</h2><p class="dim">When nothing is found online, the server can listen to a film or episode and write subtitles in the language spoken (Find subtitles → Make subtitles from the sound). It needs a speech-to-text program on the server — whisper.cpp or OpenAI’s whisper — and works in the background: nothing about how the film plays changes. It is slow work for a small server, one title at a time.</p>' +
          (g.available ? '<p>' + V.icon('check', 'tiny ok') + ' Found: <b>' + V.esc(g.kind === 'cpp' ? 'whisper.cpp' : 'whisper') + '</b> <span class="dim small">' + V.esc(g.bin) + (g.model ? ' · model ' + V.esc(g.model) : '') + '</span></p>' +
            (g.ffmpeg ? '' : '<p class="note warn">' + V.icon('info') + ' <span>It also needs ffmpeg, which isn’t on this server.</span></p>') +
            '<label class="field"><span>Who can ask for them</span><select class="input" data-subgen-mode>' + [['everyone', 'Everyone'], ['admin', 'Only the admin'], ['off', 'Nobody (off)']].map(function (o) { return '<option value="' + o[0] + '"' + (g.mode === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>'
            : '<p class="note">' + V.icon('info') + ' <span>Not set up: ' + V.esc(g.why || 'no program found') + ' See “Subtitles made from the sound” in docs/integrations.md.</span></p><div class="btn-row"><button class="btn sm" data-subgen-again>Look again</button></div>');
      };
      V.api('/api/admin/subgen').then(drawGen).catch(function () { var sec = V.$('[data-subgen]', body); if (sec) sec.remove(); });
      // (This page is drawn again into the same element after a save: its listeners are added once.)
      if (!body._subgenWired) {
        body._subgenWired = true;
        body.addEventListener('change', function (e) {
          if (e.target.hasAttribute('data-sub-listen')) { V.put('/api/admin/integrations', { subListen: e.target.value }).then(function () { S.settings.subListen = e.target.value !== 'never'; V.toast('Saved'); }).catch(V.fail); return; }
          if (!e.target.hasAttribute('data-subgen-mode')) return;
          V.adminSave({ subGen: e.target.value }).then(function () { S.settings.subGen = e.target.value === 'off' ? '' : e.target.value; }).catch(function () {});
        });
        body.addEventListener('click', function (e) {
          var b = e.target.closest('[data-subgen-again]');
          if (b) { b.disabled = true; V.api('/api/admin/subgen?again=1').then(function (g) { drawGen(g); V.toast(g.available ? 'Found it' : 'Still not found'); }).catch(V.fail); }
        });
      }
      body.onclick = function (e) {
        var s = e.target.closest('[data-save]');
        if (s && !s.disabled) {
          var val = function (k) { var el = V.$('[data-f="' + k + '"]', body); return el ? el.value : undefined; };
          var on = function (k) { var el = V.$('[data-src="' + k + '"]', body); return !!(el && el.checked); };
          var patch = s.dataset.save === 'os' ? { opensubtitles: { apiKey: val('os.apiKey'), username: val('os.username'), password: val('os.password') } }
            : { subdl: { apiKey: val('sd.apiKey') }, sources: { gestdown: on('gestdown') } };
          s.disabled = true;
          V.put('/api/admin/integrations', patch).then(function () { V.toast('Saved — reload other open pages to see the change'); V.adminTabs.integrations(body, A, '[data-save="' + s.dataset.save + '"]'); }).catch(function (err) { s.disabled = false; V.fail(err); });
        }
        var tb = e.target.closest('[data-test]');
        if (tb && tb.disabled) return;
        if (tb) tb.disabled = true;
        var again = function () { tb.disabled = false; };
        if (tb && tb.dataset.test === 'all') {
          var box = V.$('.all-test', body);
          box.textContent = 'Testing…';
          var NAMES = { subdl: 'SubDL', gestdown: 'Addic7ed (Gestdown)', opensubtitles: 'OpenSubtitles' };
          V.api('/api/admin/integrations/subtitles/test', { method: 'POST' }).then(function (r) {
            box.innerHTML = '<ul class="simple">' + Object.keys(NAMES).map(function (k) {
              var x = r[k] || {};
              var msg = !x.on ? '<span class="dim">off</span>' : !x.ok ? '<span class="err">' + V.esc(x.error || 'failed') + '</span>' :
                V.icon('check', 'tiny ok') + ' works' + (k === 'gestdown' ? ' (episodes only)' : x.found !== undefined ? ' — ' + V.plural(x.found, 'result') + ' for The Matrix' : '');
              return '<li><b>' + NAMES[k] + '</b>: ' + msg + '</li>';
            }).join('') + '</ul>';
          }).catch(function (e) { box.innerHTML = '<span class="err">' + V.esc(e.message) + '</span>'; }).then(again);
          return;
        }
        if (tb) {
          var out = V.$('.os-test', body);
          out.textContent = 'Testing…';
          V.api('/api/admin/integrations/opensubtitles/test', { method: 'POST' }).then(function (r) { out.innerHTML = r.ok ? V.icon('check', 'tiny ok') + ' The API key works' + (r.account ? ', and the account signed in.' : r.error ? ', but the account didn’t sign in: ' + V.esc(r.error) : '.') : '<span class="err">' + V.esc(r.error || 'It didn’t work.') + '</span>'; })
            .catch(function (e) { out.innerHTML = '<span class="err">' + V.esc(e.message) + '</span>'; }).then(again);
        }
      };
    }).catch(function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  };

  // ------------------------------------------------------------ Admin → API & automations
  var SCOPE = { read: 'Read only — what’s playing, devices, search, channels', control: 'Control devices — also play, pause, stop, change channel, volume', admin: 'Admin — everything, including list refreshes' };
  V.adminTabs.api = function (body, A, refocus) {
    if (!refocus) body.innerHTML = '<div class="spinner"></div>';
    var reload = function (sel) { V.adminTabs.api(body, A, sel || '[data-a=newkey]'); };
    V.api('/api/admin/integrations').then(function (I) {
      var base = location.origin + '/api/v1';
      var profOpts = '<option value="">Any profile (sees everything)</option>' + ((A && A.profiles) || []).map(function (p) { return '<option value="' + p.id + '">Only ' + V.esc(p.name) + '’s devices and titles</option>'; }).join('');
      body.innerHTML = '<section class="card-sec"><h2>API keys</h2><p class="dim">For Home Assistant, scripts and other automations. Send the key as <code>Authorization: Bearer &lt;key&gt;</code> to <code>' + V.esc(base) + '</code>. A key is shown once, when it’s made.</p>' +
        (I.apiKeys.length ? '<ul class="simple">' + I.apiKeys.map(function (k) { return '<li class="row-between"><span><b>' + V.esc(k.name) + '</b> <span class="dim">· ' + V.esc(k.scope) + ' · <code>' + V.esc(k.hint) + '</code> · ' + (k.lastUsed ? 'used ' + V.fmtAgo(k.lastUsed) : 'never used') + '</span></span><button class="btn sm danger" data-revoke="' + V.esc(k.id) + '">Revoke</button></li>'; }).join('') + '</ul>' : '<p class="dim">No keys yet.</p>') +
        '<div class="grid2"><label class="field"><span>Name</span><input class="input" data-k="name" placeholder="Home Assistant" maxlength="60"></label><label class="field"><span>It may</span><select class="input" data-k="scope">' + I.scopes.map(function (s) { return '<option value="' + s + '"' + (s === 'control' ? ' selected' : '') + '>' + V.esc(SCOPE[s]) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>Profile</span><select class="input" data-k="profile">' + profOpts + '</select></label></div><button class="btn primary" data-a="newkey">' + V.icon('plus') + ' Make a key</button>' +
        '<details class="api-ref"><summary>What the API can do</summary><ul class="small">' +
        ['GET /now — what each device is playing', 'GET /devices — signed-in devices (the id is used below)', 'POST /devices/{id}/play — {"k": "…"} or {"channel": 101} or {"title": "…"}', 'POST /devices/{id}/command — {"cmd": "pause" | "resume" | "toggle" | "stop" | "zap" (+ "dir": 1 or -1) | "channel" (+ "n") | "volume" (+ "v": 0–1) | "mute" | "seek" (+ "pos") | "sleep" (+ "min")}', 'GET /search?q=… — titles and channels', 'GET /channels — every channel with its number', 'GET /items/{k} — one title', 'GET /status — lists, accounts (admin keys)', 'POST /lists/{id}/refresh — refresh a list (admin keys)'].map(function (x) { return '<li><code>' + V.esc(x) + '</code></li>'; }).join('') + '</ul></details></section>' +
        '<section class="card-sec"><h2>Webhooks</h2><p class="dim">The server sends a short JSON message to these addresses when something happens. Each is signed: <code>X-Signature: sha256=…</code> (HMAC-SHA256 of the body with the webhook’s secret). Failed deliveries are tried again three times.</p>' +
        (I.webhooks.length ? '<ul class="simple">' + I.webhooks.map(function (h) { return '<li><div class="row-between"><span><b>' + V.esc(h.name) + '</b> <span class="dim">· ' + V.esc(h.url) + '</span>' + (h.enabled ? '' : ' <span class="chip sm">off</span>') + '</span><span class="btn-row"><button class="btn sm" data-htest="' + V.esc(h.id) + '">Send a test</button><button class="btn sm" data-hsecret="' + V.esc(h.id) + '">Secret</button><button class="btn sm danger" data-hdel="' + V.esc(h.id) + '">Delete</button></span></div><div class="dim small">' + h.events.map(function (e) { return V.esc(I.events[e] || e); }).join(' · ') + '</div></li>'; }).join('') + '</ul>' : '<p class="dim">No webhooks yet.</p>') +
        '<div class="grid2"><label class="field"><span>Address</span><input class="input" data-h="url" placeholder="http://homeassistant.local:8123/api/webhook/iptv" spellcheck="false"></label><label class="field"><span>Name</span><input class="input" data-h="name" placeholder="Home Assistant" maxlength="60"></label></div>' +
        '<div class="chips">' + Object.keys(I.events).map(function (e) { return '<label class="chip-check"><input type="checkbox" data-ev="' + e + '"' + (/^playback/.test(e) ? ' checked' : '') + '><span>' + V.esc(I.events[e]) + '</span></label>'; }).join('') + '</div>' +
        '<button class="btn primary" data-a="newhook">' + V.icon('plus') + ' Add webhook</button>' +
        '<h3>Recent deliveries</h3>' + (I.deliveries.length ? '<ul class="simple small">' + I.deliveries.map(function (d) { return '<li>' + (d.ok ? V.icon('check', 'tiny ok') : V.icon('x', 'tiny err')) + ' <b>' + V.esc(d.event) + '</b> → ' + V.esc(d.name) + ' <span class="dim">· ' + V.fmtAgo(d.at) + ' · ' + (d.status ? 'HTTP ' + d.status : V.esc(d.error || 'no answer')) + (d.attempt > 1 ? ' · try ' + d.attempt : '') + '</span></li>'; }).join('') + '</ul>' : '<p class="dim small">None yet.</p>') + '</section>';
      focusBack(body, refocus);
      // A key or secret to copy (V.copy also works on plain-http addresses, where the clipboard API doesn't).
      var showSecret = function (title, intro, value, copy) {
        return V.dialog({ title: title, body: (intro ? '<p>' + intro + '</p>' : '') + '<input class="input mono" readonly value="' + V.esc(value) + '" data-selall>', actions: (copy ? [{ label: 'Copy', fn: function () { V.copy(value); return false; } }] : []).concat([{ label: 'Done', primary: true }]) });
      };
      // One request per button at a time.
      var once = function (b, req) { if (b.disabled) return; b.disabled = true; req().catch(V.fail).then(function () { if (b.isConnected) b.disabled = false; }); };
      body.onclick = function (e) {
        var b;
        if ((b = e.target.closest('[data-a=newkey]'))) {
          once(b, function () {
            return V.api('/api/admin/apikeys', { body: { name: V.$('[data-k=name]', body).value, scope: V.$('[data-k=scope]', body).value, profile: V.$('[data-k=profile]', body).value } }).then(function (r) {
              showSecret('Your new API key', 'Copy it now — it won’t be shown again.', r.key, true).then(function () { reload(); });
            });
          });
        } else if ((b = e.target.closest('[data-revoke]'))) {
          V.confirm('Revoke this key? Anything using it stops working.', { ok: 'Revoke', danger: true }).then(function (ok) { if (ok) V.del('/api/admin/apikeys/' + encodeURIComponent(b.dataset.revoke)).then(function () { V.toast('Key revoked'); reload(); }).catch(V.fail); });
        } else if ((b = e.target.closest('[data-a=newhook]'))) {
          var evs = V.$$('[data-ev]', body).filter(function (x) { return x.checked; }).map(function (x) { return x.dataset.ev; });
          once(b, function () {
            return V.api('/api/admin/webhooks', { body: { url: V.$('[data-h=url]', body).value, name: V.$('[data-h=name]', body).value, events: evs } }).then(function (h) {
              showSecret('Webhook added', 'Its signing secret (also under “Secret” later):', h.secret).then(function () { reload('[data-a=newhook]'); });
            });
          });
        } else if ((b = e.target.closest('[data-hdel]'))) {
          V.confirm('Delete this webhook?', { ok: 'Delete', danger: true }).then(function (ok) { if (ok) V.del('/api/admin/webhooks/' + encodeURIComponent(b.dataset.hdel)).then(function () { V.toast('Webhook deleted'); reload('[data-a=newhook]'); }).catch(V.fail); });
        } else if ((b = e.target.closest('[data-htest]'))) {
          var hid = b.dataset.htest;
          once(b, function () {
            return V.api('/api/admin/webhooks/' + encodeURIComponent(hid) + '/test', { method: 'POST' }).then(function (d) {
              V.toast(d.ok ? 'Delivered (HTTP ' + d.status + ')' : 'Not delivered: ' + (d.status ? 'HTTP ' + d.status : d.error), d.ok ? {} : { error: true });
              setTimeout(function () { reload('[data-htest="' + hid + '"]'); }, 300);
            });
          });
        } else if ((b = e.target.closest('[data-hsecret]'))) {
          once(b, function () { return V.api('/api/admin/webhooks/' + encodeURIComponent(b.dataset.hsecret) + '/secret').then(function (r) { showSecret('Signing secret', '', r.secret); }); });
        }
      };
    }).catch(function (e) { body.innerHTML = '<p class="err">' + V.esc(e.message) + '</p>'; });
  };
})();
