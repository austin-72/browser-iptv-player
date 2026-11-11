'use strict';
// The bundled libraries are the releases VENDOR.md says they are: a file that changes without that page changing
// (an update nobody wrote down, or something that shouldn't have happened) fails here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

test('the bundled libraries match VENDOR.md', () => {
  const root = path.join(__dirname, '..');
  const doc = fs.readFileSync(path.join(root, 'VENDOR.md'), 'utf8');
  const listed = new Map([...doc.matchAll(/^([0-9a-f]{64}) {2}(\S+)$/gm)].map((m) => [m[2], m[1]]));
  const dir = path.join(root, 'public', 'vendor');
  const files = fs.readdirSync(dir).filter((f) => /\.js$/.test(f)).sort();
  assert.deepStrictEqual([...listed.keys()].sort(), files, 'every script in public/vendor is on the page, and nothing else');
  for (const f of files) assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex'), listed.get(f), f + ' isn’t the file VENDOR.md describes');
  // Each one's version is written down (the loader is this project's own).
  for (const f of files) if (!/loader/.test(f)) assert.match(doc, new RegExp('\\| `' + f.replace(/[.]/g, '\\.') + '` \\| [^|]+ \\| \\d+\\.\\d+\\.\\d+ \\|'), f + ' has no version');
});
