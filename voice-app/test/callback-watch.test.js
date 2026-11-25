/**
 * Callback watch: call only on a change INTO the wanted value.
 * Run with: node --test test/callback-watch.test.js
 */
const test = require('node:test');
const assert = require('assert');
const cw = require('../lib/callback-watch');

function setupFake(seq) {
  const calls = [];
  let i = 0;
  cw._reset();
  cw.setup({ haGet: async () => seq[Math.min(i++, seq.length - 1)], placeCall: async (w) => { calls.push(w); } });
  return calls;
}
const flush = () => new Promise(r => setTimeout(r, 0));

test('already matching at start: waits for leave + return', async () => {
  const calls = setupFake(['cleaning', 'cleaning', 'washing pads', 'cleaning']);
  cw.add({ entity: 'vacuum.stroborobo', values: 'cleaning', to: '502', message: 'los' });
  await flush();                 // baseline: cleaning (not armed)
  await cw.pollAll();            // cleaning → no call
  assert.strictEqual(calls.length, 0);
  await cw.pollAll();            // washing pads → armed
  await cw.pollAll();            // cleaning → call
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].to, '502');
  assert.strictEqual(cw.watches.size, 0);
  cw._reset();
});

test('change from docked to cleaning calls once; validation', async () => {
  const calls = setupFake(['docked', 'cleaning', 'cleaning']);
  cw.add({ entity: 'vacuum.stroborobo', values: ['Cleaning', 'segment_cleaning'], to: '502', message: 'los' });
  await flush();
  await cw.pollAll();
  await cw.pollAll();
  assert.strictEqual(calls.length, 1);
  assert.throws(() => cw.add({ entity: 'bad', values: 'x', to: '502', message: 'm' }), /entity/);
  assert.throws(() => cw.add({ entity: 'vacuum.x', values: 'x', to: 'abc', message: 'm' }), /to/);
  cw._reset();
});

test('expired watch is dropped without call', async () => {
  const calls = setupFake(['docked', 'cleaning']);
  const w = cw.add({ entity: 'vacuum.stroborobo', values: 'cleaning', to: '502', message: 'los', hours: 1 });
  await flush();
  w.expires = Date.now() - 1;
  await cw.pollAll();
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(cw.watches.size, 0);
  cw._reset();
});
