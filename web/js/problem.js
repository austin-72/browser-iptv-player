/* "Report a problem": in the player's menu and on the "Can't play this right now" message. The viewer picks what's
   wrong and can add a note; it goes to Admin → Error reports as "Reported by a viewer", with the same details as the
   automatic reports (device, what was playing and how, what happened just before) plus, when the title wouldn't play,
   every way it tried. Always sent, even when the same problem was reported a moment ago (errors.js), at most 5 in 10
   minutes from one device. */
'use strict';
(function () {
  var CHOICES = [
    ['play', 'Won’t play'], ['buffer', 'Stutters or buffers'], ['sound', 'No sound'], ['sync', 'Sound out of sync'],
    ['wrong', 'Plays something else'], ['subs', 'Wrong subtitles'], ['info', 'Wrong title or picture'], ['other', 'Other'],
  ];
  /**
   * Likely secrets in the note ("my PIN is 4321", "password: hunter2") become "…" before it leaves the device (the
   * server does the same again: scrubNote in lib/errors.js).
   */
  var NOTE_WORDS = /^(are|and|or|but|not|doesn'?t|does|did|didn'?t|won'?t|isn'?t|wrong|again|for|the|a|an|it|in|on|box|field|screen|prompt|page|keeps|asked|needed|needs|required|works?|changed?)[.,;:!?]*$/i;
  var scrubNote = V.scrubNote = function (s) {
    return String(s == null ? '' : s).replace(/\b(pin ?codes?|pass ?codes?|pins?|codes?|passwords?|passwd|pwd|pw)\b((?:\s+(?:is|was|=|of|to|it'?s|its))*\s*[:=#-]?\s*)(\S+)/gi, function (m, w, mid, tok) {
      if (NOTE_WORDS.test(tok)) return m;
      if (/^p(ass ?w|w)/i.test(w) && !/^pass ?codes?$/i.test(w)) return w + mid + '…';
      if (/^codes?$/i.test(w) ? /\d{4,}/.test(tok) : /\d/.test(tok)) return w + mid + '…';
      return m;
    });
  };
  var nameOf = function (it) { return it.t === 'episode' ? ((V.showOf(it) || {}).n || it.n) + ' ' + V.epLabel(it) : it.n; };

  /** What's useful to know about the title and the player's sound for this report. */
  var details = function (p, it, choice, failed) {
    var v = p.video || {};
    var o = {
      item: { k: it.k, sk: it.sk || undefined, t: it.t, n: it.n, show: it.t === 'episode' ? (V.showOf(it) || {}).n : undefined, g: it.g, alt: p.alt, backups: (it.a || []).length, ext: (String(it.u || '').split('?')[0].match(/\.(\w{2,5})$/) || [])[1] || '' },
      failed: failed,
    };
    // Something else started playing while the form was open: the player's details would be about that instead.
    if (p.it !== it) { o.item.alt = undefined; o.playerMovedOn = true; return o; }
    if (failed && p._failedWith) o.final = p._failedWith.message;
    if (p._attemptLog && p._attemptLog.length) o.attempts = p._attemptLog.slice();
    if (choice === 'sound' || choice === 'sync') {
      o.sound = { muted: !!v.muted, volume: Math.round((v.volume || 0) * 100) / 100, boost: p.boost, avsync: p.avOffset || 0, webAudio: !!p._audioSrc, clearDialogue: !!V.pref('clearDialogue'), nightMode: !!V.pref('nightMode'), audioTrack: p.audioTrack };
    }
    if (choice === 'info') o.picture = it.i || '';
    if (choice === 'subs') { var tr = p._tracks ? p._tracks() : {}; o.subtitles = tr.subs ? tr.subs.value : 'none'; o.subLang = V.pref('subLang') || ''; }
    return o;
  };

  /** Opens the form. p: the player (V.player). opts: { failed: it couldn't be played } */
  V.reportProblem = function (p, opts) {
    p = p || V.player;
    opts = opts || {};
    var it = p && p.it;
    if (!it) return;
    var failed = !!(opts.failed || p._failedWith);
    var pick = failed ? 'play' : '';
    V.dialog({
      title: 'Report a problem',
      cls: 'prob-dlg',
      body: '<p class="dim">With “' + V.esc(nameOf(it)) + '”. What’s wrong? It’s sent to whoever looks after this server, with the details they need to look into it.</p>' +
        '<div class="chips prob-choices" role="group" aria-label="What’s wrong">' + CHOICES.map(function (c) { return '<button type="button" class="chip" data-c="' + c[0] + '" aria-pressed="' + (c[0] === pick) + '">' + V.icon('check', 'pc-check') + V.esc(c[1]) + '</button>'; }).join('') + '</div>' +
        '<label class="field"><span>Anything else? (optional)</span><textarea class="input" rows="3" maxlength="500" data-note placeholder="For example: it stops after about ten minutes"></textarea></label>',
      onOpen: function (d) {
        V.$('.prob-choices', d).addEventListener('click', function (e) {
          var b = e.target.closest('[data-c]');
          if (!b) return;
          pick = b.dataset.c;
          V.$$('[data-c]', d).forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
        });
        var on = V.$('[aria-pressed=true]', d);
        if (on) setTimeout(function () { on.focus(); }, 40);
      },
      actions: [{ label: 'Cancel', value: null }, { label: 'Send', primary: true, fn: function (d) {
        if (!pick) { V.toast('Choose what’s wrong first', { error: true }); var f = V.$('[data-c]', d); if (f) f.focus(); return false; }
        var label = CHOICES.filter(function (c) { return c[0] === pick; })[0][1];
        var note = scrubNote(V.$('[data-note]', d).value.trim().slice(0, 500));
        var extra = details(p, it, pick, failed);
        extra.choice = pick; extra.choiceLabel = label; extra.note = note;
        var sent = V.reportError && V.reportError('user', { message: label + ' — ' + nameOf(it) }, extra);
        if (!sent) { V.toast('You’ve sent several reports just now. Please try again in a few minutes.', { error: true }); return false; }
        V.toast('Thanks for letting us know — your report has been sent.');
        return true;
      } }],
    });
  };

  /**
   * The admin: this copy plays something else (another title under this one's name) — hidden for everyone; another
   * copy takes over, or the title goes when there's none (lib/badcopies.js). Undone in Admin → Languages & content.
   * c: { k, sk, alt, name, t }. → a promise of whether it was hidden.
   */
  V.hideCopy = function (c) {
    var many = c.copies > 1;
    return V.confirm('Hide this copy of “' + c.name + '” for everyone? It plays something else.' + (many ? ' Another copy of it takes over.' : ' There’s no other copy, so the ' + (c.t === 'episode' ? 'episode' : 'film') + ' goes until you show it again.') + ' (Admin → Languages & content shows what’s hidden.)', { ok: 'Hide this copy', danger: true }).then(function (ok) {
      if (!ok) return false;
      return V.api('/api/admin/badcopies', { body: { k: c.k, sk: c.sk || undefined, alt: c.alt, why: c.why || '' } }).then(function (r) {
        V.toast('Hidden for everyone' + (r.left ? ' — ' + V.plural(r.left, 'other copy', 'other copies') + ' left' : '') + '.');
        return true;
      });
    }).catch(function (e) { V.fail(e); return false; });
  };

  var prev = V.playerMenuExtras;
  V.playerMenuExtras = function (p, main, pages) {
    if (prev) prev(p, main, pages);
    if (p.it) main.push({ label: 'Report a problem', value: '', fn: function () { V.reportProblem(p); } });
    if (p.it && S.profile && S.profile.admin && (p.it.t === 'movie' || p.it.t === 'episode')) {
      main.push({ label: 'Plays something else', value: '', fn: function () {
        var it = p.it;
        V.hideCopy({ k: it.k, sk: it.sk, alt: p.alt, t: it.t, name: nameOf(it), copies: 1 + (it.a || []).length }).then(function (ok) {
          if (!ok || p.it !== it) return;
          // Another copy plays from here; with none, the player closes.
          if (it.a && it.a.length) p.load(it, { startAt: p.vod ? p.position : 0 });
          else V.closePlayer();
        });
      } });
    }
  };
})();
