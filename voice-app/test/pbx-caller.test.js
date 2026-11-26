/**
 * PBX caller headers, greeting, REFER outcome.
 * Run with: node --test test/pbx-caller.test.js
 */
const test = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const { extractPbxCaller } = require('../lib/sip-handler');
const { identifyCaller, operatorGreeting, spokenDigits } = require('../lib/extension-handlers');
const { waitForReferOutcome } = require('../lib/call-session');

const req = (h) => ({ get: (k) => h[k] });

test('X-PBX-Caller headers are decoded', () => {
  const c = extractPbxCaller(req({ 'X-PBX-Caller-Ext': '502', 'X-PBX-Caller-Person': 'julian',
    'X-PBX-Caller-Name': 'Julian', 'X-PBX-Caller-Geraet': 'Snom',
    'X-PBX-Caller-Ort': 'Julians%20Zimmer%2C%20Schreibtisch%20links' }));
  assert.deepStrictEqual(c, { ext: '502', person: 'julian', name: 'Julian', geraet: 'Snom',
    ort: 'Julians Zimmer, Schreibtisch links' });
  assert.strictEqual(extractPbxCaller(req({})), null);
});

test('greeting: personal with device/place, shared phone by place, fallback by extension', () => {
  const julian = identifyCaller('502', { ext: '502', person: 'julian', name: 'Julian', geraet: 'Snom',
    ort: 'Julians Zimmer, Schreibtisch links' });
  assert.strictEqual(julian.owner, true);
  assert.match(julian.line, /Nebenstelle 502 – Julian, Gerät: Snom, Ort: Julians Zimmer/);
  assert.match(operatorGreeting(julian),
    /Vermittlung\. Hallo Julian, du rufst vom Snom an – Julians Zimmer, Schreibtisch links\. Wen soll ich stöpseln/);

  const wz = identifyCaller('500', { ext: '500', person: '', name: '', geraet: '', ort: 'Wohnzimmer' });
  assert.strictEqual(wz.owner, false);
  assert.match(operatorGreeting(wz), /Vermittlung\. Hallo, du rufst vom Wohnzimmer an\. Wen soll ich/);

  assert.match(operatorGreeting({ name: '', extension: '402' }), /Vermittlung\. Hallo, du rufst von Nebenstelle 4 0 2 an\./);
  assert.strictEqual(spokenDigits('*1'), 'Stern 1');
});

test('REFER outcome: 404 sipfrag fails, dialog end succeeds, timeout null', async () => {
  const mk = () => Object.assign(new EventEmitter(), {});
  let d = mk();
  let o = waitForReferOutcome(d, 1000);
  let answered = 0;
  d.emit('notify', { body: 'SIP/2.0 100 Trying' }, { send: () => answered++ });
  d.emit('notify', { body: 'SIP/2.0 404 Not Found\r\n' }, { send: () => answered++ });
  assert.deepStrictEqual(await o.promise, { code: 404, reason: 'Not Found' });
  assert.strictEqual(answered, 2);
  assert.strictEqual(d.listenerCount('notify'), 0);

  d = mk(); o = waitForReferOutcome(d, 1000); d.emit('destroy');
  assert.strictEqual((await o.promise).code, 200);

  d = mk(); o = waitForReferOutcome(d, 20);
  assert.strictEqual(await o.promise, null);
});
