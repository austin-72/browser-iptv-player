// Provider accounts: a playlist link from an Xtream panel has the same account; a check that worked clears an old error.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Lists } = require('../lib/lists');

test('the account behind a list, and an old error cleared by a check that worked', () => {
  const lists = new Lists({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'acct-')), media: {}, getSettings: () => ({}) });
  assert.deepStrictEqual(lists.xtAccountOf({ type: 'url', url: 'http://panel.example:8080/get.php?username=ann&password=p%40ss&type=m3u_plus&output=ts' }), { server: 'http://panel.example:8080', username: 'ann', password: 'p@ss', ua: undefined });
  assert.strictEqual(lists.xtAccountOf({ type: 'url', url: 'http://example.com/list.m3u' }), null);
  const x = { type: 'xtream', server: 'http://a', username: 'u', password: 'p' };
  assert.strictEqual(lists.xtAccountOf(x), x);
  const l = { type: 'xtream', account: { status: 'Active', error: 'The server answered HTTP 881', checkedAt: 1 } };
  lists._setAccount(l, { status: 'Active', exp_date: '1893456000', max_connections: '2', active_cons: '1', is_trial: '0' });
  assert.strictEqual(l.account.error, undefined);
  assert.strictEqual(l.account.maxConnections, '2');
  assert.strictEqual(l.account.expires, 1893456000000);
  assert.ok(l.account.checkedAt > 1);
});
