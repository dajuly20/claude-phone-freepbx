/**
 * Recent targets + silence timeout of waitForUtterance.
 * Run with: node --test test/recent-targets.test.js
 */
const test = require('node:test');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const rt = require('../lib/recent-targets');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-')), 'r.json');

test('per caller first, then global, then fillers; no 110/112, no self', () => {
  const f = tmp(); rt._reset();
  rt.record('222', '24', f);
  rt.record('222', '112', f);
  rt.record('223', '7', f);
  rt.record('222', '228', f);
  assert.deepStrictEqual(rt.recent('222', 5, ['701', '222', '22'], f), ['228', '24', '7', '701', '22']);
});

test('persists to disk', () => {
  const f = tmp(); rt._reset();
  rt.record('222', '24', f);
  rt._reset();
  assert.deepStrictEqual(rt.recent('222', 5, [], f), ['24']);
});

test('waitForUtterance rejects with NO_SPEECH, speaking cancels it', async () => {
  const { EventEmitter } = require('events');
  const af = require('../lib/audio-fork');
  const Session = af.AudioForkSession || Object.values(af).find(v => typeof v === 'function' &&
    v.prototype && v.prototype.waitForUtterance);
  const fake = Object.assign(new EventEmitter(), { callUuid: 'x', _inSpeech: false, _binaryCount: 0 });
  const wait = Session.prototype.waitForUtterance.bind(fake);

  await assert.rejects(wait({ timeoutMs: 1000, noSpeechMs: 20 }), e => e.code === 'NO_SPEECH');

  const p = wait({ timeoutMs: 1000, noSpeechMs: 20 });
  fake.emit('speechStart');
  setTimeout(() => fake.emit('utterance', { audio: Buffer.alloc(4) }), 60);
  const u = await p;
  assert.strictEqual(u.audio.length, 4);
});
