'use strict';
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const hash = (s, len = 12) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, len);
const uid = () => crypto.randomBytes(6).toString('hex');

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8', extra = {}) {
  const body = Buffer.from(text);
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // (A request that never sends its body — or stops half-way — doesn't hold its connection for good: 60 seconds
    // without a byte ends it. Big uploads keep going as long as they keep coming.)
    let idle = setTimeout(function end() { reject(new HttpError(408, 'The request took too long to arrive.')); req.destroy(); }, 60000);
    const alive = () => { clearTimeout(idle); idle = setTimeout(() => { reject(new HttpError(408, 'The request took too long to arrive.')); req.destroy(); }, 60000); };
    req.on('data', alive);
    req.on('end', () => clearTimeout(idle));
    req.on('error', () => clearTimeout(idle));
    req.on('close', () => clearTimeout(idle));
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

const isUrl = (s) => /^https?:\/\//i.test(String(s || ''));

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(hd|fhd|uhd|4k|sd|hevc|h265|h264|1080p|720p|backup)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function safeFilename(s) {
  return String(s || 'untitled')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'untitled';
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function log(...args) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${t}]`, ...args);
}

/** A guest's profile id ("guest-…"): a profile that isn't kept — see Accounts.startGuest. */
const isGuestId = (id) => /^guest-[0-9a-f]{12}$/.test(String(id || ''));

module.exports = { isGuestId, HttpError, hash, uid, sendJSON, sendText, readBody, readJSON, isUrl, normName, safeFilename, clampInt, log };
