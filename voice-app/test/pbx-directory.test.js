/**
 * PBX directory: fetch + cache + fallback + merge.
 * Run with: node --test test/pbx-directory.test.js
 */
const test = require('node:test');
const assert = require('assert');
const pbx = require('../lib/pbx-directory');

const BOOK = {
  stand: '2026-11-25T16:10:00+01:00',
  regeln: ['Personen: 2x anrufen'],
  ziele: [
    { nummer: '22', name: 'Julian', art: 'person', beschreibung: 'Person' },
    { nummer: '701', name: 'Julians Rechner', art: 'agent', beschreibung: 'KI-Agent' }
  ]
};
const devices = {
  700: { extension: '700', name: 'Vermittlung' },
  701: { extension: '701', name: 'Alter Name' },
  703: { extension: '703', name: 'Szenen', description: 'Szenen-Agent' }
};
const directory = { 99: 'Konferenz alt' };

test('fetch caches and buildText merges (PBX wins)', async () => {
  pbx._resetCache();
  let calls = 0;
  const http = { get: async () => { calls++; return { data: BOOK }; } };
  const a = await pbx.fetchDirectory({ http });
  await pbx.fetchDirectory({ http });
  assert.strictEqual(calls, 1);

  const text = pbx.buildText(a, devices, directory, '700');
  assert.match(text, /- 22: Julian – Person/);
  assert.match(text, /- 701: Julians Rechner/);
  assert.doesNotMatch(text, /Alter Name/);
  assert.doesNotMatch(text, /Vermittlung/);
  assert.match(text, /- 703: Szenen – Szenen-Agent/);
  assert.doesNotMatch(text, /Konferenz alt/);
  assert.match(text, /Regeln:\n- Personen: 2x anrufen/);
});

test('fetch failure without cache returns null → static fallback', async () => {
  pbx._resetCache();
  const http = { get: async () => { throw new Error('timeout'); } };
  const a = await pbx.fetchDirectory({ http });
  assert.strictEqual(a, null);
  const text = pbx.buildText(a, devices, directory, '700');
  assert.match(text, /- 701: Alter Name/);
  assert.match(text, /- 99: Konferenz alt/);
});

test('fetch failure with cache returns stale cache', async () => {
  pbx._resetCache();
  await pbx.fetchDirectory({ http: { get: async () => ({ data: BOOK }) } });
  const a = await pbx.fetchDirectory({ force: true, http: { get: async () => { throw new Error('down'); } } });
  assert.strictEqual(a.ziele.length, 2);
});

test('invalid answer is rejected', async () => {
  pbx._resetCache();
  const a = await pbx.fetchDirectory({ http: { get: async () => ({ data: '<html>' }) } });
  assert.strictEqual(a, null);
});
