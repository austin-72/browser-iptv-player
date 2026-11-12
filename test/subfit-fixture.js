'use strict';
// A pretend film's sound with known talk in it, for the subtitle tests: bursts of noise that rise and fall the way
// syllables do, over a steady hum — and the "subtitles" for it, timed the way people time them.
const RATE = 8000;
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
/** → { pcm: Int16Array (mono, 8 kHz), cues: [{ s, e, text }], vtt } */
function film(seed, secs) {
  const r = rng(seed), n = Math.round(secs * RATE), pcm = new Int16Array(n), talk = [];
  for (let i = 0; i < n; i++) pcm[i] = Math.round(700 * Math.sin(2 * Math.PI * 220 * i / RATE) + (r() - 0.5) * 120);
  let t = 2 + r() * 8;
  while (t < secs - 6) {
    const lines = 2 + Math.floor(r() * 7);
    for (let l = 0; l < lines && t < secs - 6; l++) {
      const len = 0.8 + r() * 3.2, a = Math.round(t * RATE), b = Math.min(n, Math.round((t + len) * RATE));
      // syllables: about five a second
      for (let i = a; i < b;) {
        const on = Math.round((0.1 + r() * 0.14) * RATE), off = Math.round((0.04 + r() * 0.09) * RATE), amp = 3000 + r() * 6000;
        for (let j = 0; j < on && i + j < b; j++) pcm[i + j] = Math.max(-32000, Math.min(32000, pcm[i + j] + Math.round((r() - 0.5) * 2 * amp * Math.sin(Math.PI * j / on))));
        i += on + off;
      }
      talk.push([t, t + len]);
      t += len + [0.3, 0.5, 0.8, 1.2, 2, 3.5][Math.floor(r() * 6)];
    }
    t += r() < 0.5 ? [2, 4, 7, 12, 20, 35][Math.floor(r() * 6)] : 0.5 + r() * 2.5;
  }
  const cues = [];
  for (let i = 0; i < talk.length; i++) {
    let [s, e] = talk[i];
    while (i + 1 < talk.length && talk[i + 1][0] - e < 0.6 && talk[i + 1][1] - s < 6) { e = talk[i + 1][1]; i++; }
    if (r() < 0.06) continue; // (a line nobody wrote down)
    cues.push({ s: Math.max(0, s - r() * 0.12), e: e + 0.2 + r() * 0.6, text: 'Line ' + (cues.length + 1) });
  }
  return { pcm, cues, vtt: toVtt(cues) };
}
const ts = (x) => { const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), s = x % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`; };
const toVtt = (cues) => 'WEBVTT\n\n' + cues.map((c) => `${ts(c.s)} --> ${ts(c.e)}\n${c.text}\n`).join('\n');
const toSrt = (cues) => cues.map((c, i) => `${i + 1}\n${ts(c.s).replace('.', ',')} --> ${ts(c.e).replace('.', ',')}\n${c.text}\n`).join('\n');
/** 16-bit mono WAV of it. */
function wav(pcm) {
  const h = Buffer.alloc(44), d = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  h.write('RIFF', 0); h.writeUInt32LE(36 + d.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(d.length, 40);
  return Buffer.concat([h, d]);
}
/** read(start, secs) for lib/subcheck.js syncByEar, straight from the samples. */
const reader = (pcm) => async (start, secs) => pcm.subarray(Math.round(start * RATE), Math.min(pcm.length, Math.round((start + secs) * RATE)));
module.exports = { film, wav, reader, toVtt, toSrt, RATE };
