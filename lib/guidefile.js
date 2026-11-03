'use strict';
/**
 * Reads a guide's saved file ({"channels":{…},"programmes":{"<channel id>":[…],…},…}, as lib/epg.js writes it) without
 * turning it all into one string, and turning into objects only the channels that are wanted.
 *
 * A big guide is hundreds of MB, almost all of it programmes of channels no list here has. Reading it with
 * JSON.parse meant the whole text as one string (a guide over about 512 MB can't be one: it was skipped at every
 * start, and downloaded again), then every programme made into an object, most of them dropped straight away.
 * Here the bytes are walked instead: each channel's programmes are found by matching brackets (strings skipped as a
 * whole), counted, and parsed only when that channel is wanted.
 */

const Q = 0x22, BS = 0x5c, LB = 0x7b, RB = 0x7d, LS = 0x5b, RS = 0x5d, COMMA = 0x2c, COLON = 0x3a;
const isWs = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

/** Index just past the string starting at i (buf[i] is the opening quote). */
function strEnd(buf, i) {
  let j = i + 1;
  for (;;) {
    const q = buf.indexOf(Q, j);
    if (q < 0) throw new Error('unfinished text');
    // (A quote with an odd number of backslashes before it is part of the text.)
    let b = q - 1, n = 0;
    while (buf[b] === BS) { n++; b--; }
    if (n % 2 === 0) return q + 1;
    j = q + 1;
  }
}

/** Index just past the value starting at i; with count, also how many objects the array/object directly holds. */
function valueEnd(buf, i, counter) {
  const c = buf[i];
  if (c === Q) return strEnd(buf, i);
  if (c !== LB && c !== LS) {
    // A number, true, false or null: up to the next , } ] or space.
    let j = i;
    while (j < buf.length) { const d = buf[j]; if (d === COMMA || d === RB || d === RS || isWs(d)) break; j++; }
    return j;
  }
  let depth = 0, j = i;
  const n = buf.length;
  while (j < n) {
    const d = buf[j];
    if (d === Q) { j = strEnd(buf, j); continue; }
    if (d === LB || d === LS) { depth++; if (d === LB && depth === 2 && counter) counter.n++; }
    else if (d === RB || d === RS) { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  throw new Error('unfinished value');
}

function skipWs(buf, i) { while (i < buf.length && isWs(buf[i])) i++; return i; }
function expect(buf, i, ch, what) { i = skipWs(buf, i); if (buf[i] !== ch) throw new Error(`expected ${what} at byte ${i}`); return i + 1; }
const parse = (buf, a, b) => JSON.parse(buf.toString('utf8', a, b));

/**
 * The reading itself, in steps (a generator: the caller decides how much runs at a time — see readGuide).
 * want(channelId) → true to keep that channel's programmes (null: keep all).
 * Returns { channels, programmes (the wanted ones), ids (every channel with programmes), count (every programme) }
 * plus any other top-level fields as they are.
 */
function* guideSteps(buf, want) {
  const out = { channels: {}, programmes: {}, ids: [], count: 0 };
  let i = expect(buf, 0, LB, '{');
  i = skipWs(buf, i);
  if (buf[i] === RB) return out;
  let steps = 0;
  for (;;) {
    i = skipWs(buf, i);
    if (buf[i] !== Q) throw new Error(`expected a name at byte ${i}`);
    const ke = strEnd(buf, i);
    const key = parse(buf, i, ke);
    i = expect(buf, ke, COLON, ':');
    i = skipWs(buf, i);
    if (key === 'programmes' && buf[i] === LB) {
      // Channel by channel.
      let j = skipWs(buf, i + 1);
      if (buf[j] === RB) j++;
      else {
        for (;;) {
          j = skipWs(buf, j);
          const ce = strEnd(buf, j);
          const cid = parse(buf, j, ce);
          j = skipWs(buf, expect(buf, ce, COLON, ':'));
          const counter = { n: 0 };
          const ve = valueEnd(buf, j, counter);
          out.ids.push(cid);
          out.count += counter.n;
          if (!want || want(cid)) out.programmes[cid] = parse(buf, j, ve);
          if ((++steps & 255) === 0) yield;
          j = skipWs(buf, ve);
          if (buf[j] === COMMA) { j++; continue; }
          if (buf[j] === RB) { j++; break; }
          throw new Error(`expected , or } at byte ${j}`);
        }
      }
      i = j;
    } else {
      const ve = valueEnd(buf, i);
      const v = parse(buf, i, ve);
      if (key === 'ids' || key === 'count') { /* (worked out above, from the programmes themselves) */ } else out[key] = v;
      i = ve;
      yield;
    }
    i = skipWs(buf, i);
    if (buf[i] === COMMA) { i++; continue; }
    if (buf[i] === RB) break;
    throw new Error(`expected , or } at byte ${i}`);
  }
  return out;
}

/** The same in one go (tests, small guides). */
function readGuideSync(buf, want) {
  const g = guideSteps(buf, want);
  let r;
  while (!(r = g.next()).done);
  return r.value;
}

/** In ~20 ms slices, letting requests through in between. */
function readGuideAsync(buf, want, slice = 20) {
  return new Promise((resolve, reject) => {
    const g = guideSteps(buf, want);
    const run = () => {
      const end = Date.now() + slice;
      try {
        for (;;) {
          const r = g.next();
          if (r.done) return resolve(r.value);
          if (Date.now() >= end) break;
        }
      } catch (e) { return reject(e); }
      setImmediate(run);
    };
    run();
  });
}

module.exports = { guideSteps, readGuideSync, readGuideAsync };
