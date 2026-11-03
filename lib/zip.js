'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** A tiny .zip writer (deflate, no dependencies) for handing out a folder as a download. */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{ name, data }] → Buffer */
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Zip a folder (one level deep is enough here), inside a top folder named `top`. */
function zipFolder(dir, top, transform) {
  const files = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile()).map((n) => {
    let data = fs.readFileSync(path.join(dir, n));
    if (transform) data = transform(n, data);
    return { name: `${top}/${n}`, data };
  });
  return zip(files);
}

/** Reads a .zip: [{ name, data }] (stored or deflated entries; no encryption). */
function unzip(buf, { maxFiles = 2000, maxBytes = 200 * 1024 * 1024 } = {}) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('That isn’t a zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > maxFiles) throw new Error('Too many files in the zip.');
  const out = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip file is damaged.');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const flags = buf.readUInt16LE(p + 8);
    const name = buf.slice(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Password-protected zips aren’t supported.');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.slice(start, start + csize);
    // Never inflate past the limit: the sizes in a zip can lie, and a small "zip bomb" would otherwise unpack to
    // gigabytes in memory before the size check below.
    let data = null;
    if (method === 0) data = raw;
    else if (method === 8) {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, maxBytes - total) }); } catch (e) {
        if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('The zip is too big.');
        throw e;
      }
    }
    if (!data) throw new Error(`Unsupported compression in ${name}`);
    total += Math.max(usize, data.length);
    if (total > maxBytes) throw new Error('The zip is too big.');
    out.push({ name: name.replace(/\\/g, '/'), data });
  }
  return out;
}

module.exports = {
  unzip, zip, zipFolder, crc32 };
