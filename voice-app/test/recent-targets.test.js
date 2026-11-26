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

test('adaptive VAD: steady line noise is not speech, louder voice is', () => {
  const { AudioForkSession } = require('../lib/audio-fork');
  const s = new AudioForkSession({ ws: { on() {} }, callUuid: 'v' });
  s._pcmEndian = 'LE';
  const chunk = (amp) => {
    const b = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) b.writeInt16LE(Math.round(amp * Math.sin(i / 3) + (i % 7 - 3) * amp / 10), i * 2);
    return b;
  };
  for (let i = 0; i < 100; i++) s._trackNoise(chunk(2800)); // RMS ~2000 like phone 502
  assert.strictEqual(s._isSpeech(chunk(2800)), false);
  assert.strictEqual(s._isSpeech(chunk(15000)), true);
});

test('converse: beforeAsk stops, first silence/unclear plays hint once, handedOff ends loop', async () => {
  const { CallSession } = require('../lib/call-session');
  const said = [];
  const dialog = { on() {} };
  const call = new CallSession({ endpoint: { on() {} }, dialog, callUuid: 'c', options: {}, device: {} });
  call.say = async (t) => { said.push(t); };
  const answers = [null, 'Hauptmenü'];
  call.listen = async () => { call.lastListenSilent = true; return answers.shift(); };
  call.askClaude = async () => { throw new Error('should not ask Claude'); };
  let hints = 0;
  await call.converse('x', {
    firstSilenceMs: 5000,
    onFirstSilence: async () => { hints++; },
    beforeAsk: async (t) => (t === 'Hauptmenü' ? 'stop' : 'continue')
  });
  assert.strictEqual(hints, 1);
  assert.deepStrictEqual(said, []);

  call.handedOff = true;
  call.listen = async () => { throw new Error('loop should not run'); };
  await call.converse('x', {});
});

test('converse: silence hints run in order, stop once the caller speaks', async () => {
  const { CallSession } = require('../lib/call-session');
  const call = new CallSession({ endpoint: { on() {} }, dialog: { on() {} }, callUuid: 'c2', options: {}, device: {} });
  call.say = async () => {};
  const waits = [];
  const answers = [null, null, 'Hauptmenü'];
  call.listen = async (o) => { waits.push(o.noSpeechMs || 0); return answers.shift(); };
  const ran = [];
  await call.converse('x', {
    firstSilenceMs: 5000, onFirstSilence: async () => { ran.push('menu'); },
    silenceHints: [{ ms: 10000, run: async () => { ran.push('reveal'); } }],
    beforeAsk: async () => 'stop'
  });
  assert.deepStrictEqual(ran, ['menu', 'reveal']);
  assert.deepStrictEqual(waits, [5000, 10000, 0]);
});
