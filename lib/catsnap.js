'use strict';
/**
 * The finished catalogue saved to disk (data/catalog.snapshot), so a restart can start from it in seconds instead of
 * reading every list again and putting the catalogue together from scratch (minutes, with millions of entries).
 *
 * File: a first line naming the format, then pieces — 4 bytes of length, then gzipped JSON. The first piece says what
 * the catalogue was built from (see `head`), then the items, a few thousand per piece, then an end piece with the
 * count (a file cut short — the server stopped while writing — isn't used). Written to a temporary file and renamed.
 * Pieces are made and read a few at a time, so the server keeps answering while this runs.
 */
const fs = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');

const MAGIC = 'biptv-catalog 1\n';
const CHUNK = 5000;
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const tick = () => new Promise((r) => setImmediate(r));

/** Writes head + items (+ extra pieces: objects, kept as they are). Resolves to the number of bytes written. */
async function save(file, head, items, extras = []) {
  const tmp = file + '.tmp';
  const fh = await fs.promises.open(tmp, 'w');
  let bytes = 0;
  const put = async (obj) => {
    const z = await gzip(Buffer.from(JSON.stringify(obj)), { level: 1 });
    const len = Buffer.alloc(4);
    len.writeUInt32BE(z.length, 0);
    for (const b of [len, z]) for (let o = 0; o < b.length;) o += (await fh.write(b, o)).bytesWritten;
    bytes += 4 + z.length;
  };
  try {
    await fh.write(MAGIC);
    await put({ ...head, count: items.length });
    for (let i = 0; i < items.length; i += CHUNK) {
      await put(items.slice(i, i + CHUNK));
      await tick();
    }
    for (const x of extras) { await put({ extra: x }); await tick(); }
    await put({ end: true, count: items.length });
  } finally { await fh.close(); }
  try { await fs.promises.rename(tmp, file); } catch { await fs.promises.copyFile(tmp, file); await fs.promises.unlink(tmp).catch(() => {}); }
  return bytes + MAGIC.length;
}

/** Reads a snapshot: { head, items }, or null when there's none. Throws on a damaged or unfinished one. */
async function load(file) {
  let buf;
  try { buf = await fs.promises.readFile(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (buf.toString('utf8', 0, MAGIC.length) !== MAGIC) throw new Error('not a catalogue snapshot');
  let o = MAGIC.length;
  const next = async () => {
    if (o + 4 > buf.length) throw new Error('cut short');
    const n = buf.readUInt32BE(o);
    if (o + 4 + n > buf.length) throw new Error('cut short');
    const z = buf.subarray(o + 4, o + 4 + n);
    o += 4 + n;
    return JSON.parse((await gunzip(z)).toString('utf8'));
  };
  const head = await next();
  const items = [], extras = [];
  for (;;) {
    const piece = await next();
    if (piece && piece.extra) { extras.push(piece.extra); continue; }
    if (!Array.isArray(piece)) {
      if (!piece || !piece.end || piece.count !== items.length || items.length !== head.count) throw new Error('incomplete');
      break;
    }
    for (const it of piece) items.push(it);
    await tick();
  }
  return { head, items, extras, bytes: buf.length };
}

module.exports = { save, load };
