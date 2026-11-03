'use strict';
/**
 * Reads a list's saved copy on another thread (lib/lists.js: parseInWorker). A provider's playlist can be 400 MB
 * with over a million entries: turning that into entries took the server's only thread for many seconds at a time
 * (nobody's page or stream got an answer meanwhile). Here it runs beside it; the entries come back a slice at a time.
 */
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');

const SLICE = 25000;
try {
  const { Lists } = require('./lists');
  const P = require('./parse');
  const { file, list } = workerData;
  // (Only the parts of a Lists that turn a saved copy into entries: they use nothing else of it.)
  const lists = Object.create(Lists.prototype);
  const buf = fs.readFileSync(file);
  const parsed = lists._isJson(list) ? lists._jsonItems(list, JSON.parse(buf.toString('utf8'))) : lists._parseText(list, P.decodeText(buf));
  const items = parsed.items;
  parentPort.postMessage({ head: { ...parsed, items: undefined, count: items.length } });
  // One slice at a time, the next when the server asks for it (all at once, taking them in held it up again).
  let i = 0;
  const next = () => {
    if (i >= items.length) { parentPort.postMessage({ done: true }); parentPort.close(); return; }
    parentPort.postMessage({ items: items.slice(i, i + SLICE) });
    i += SLICE;
  };
  parentPort.on('message', next);
  next();
} catch (e) {
  parentPort.postMessage({ error: e && e.message ? e.message : String(e) });
}
