/**
 * TTS: ElevenLabs first, Home Assistant TTS when ElevenLabs has no credits.
 * Run with: node --test test/tts-fallback.test.js
 */
const test = require('node:test');
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.ELEVENLABS_API_KEY = 'x';
process.env.HA_URL = 'http://ha.test';
process.env.HA_TOKEN = 't';

// fake axios in the require cache, before tts-service loads it
const log = [];
let elevenFails = null;
const fake = async () => {
  log.push('eleven');
  if (elevenFails) throw elevenFails;
  return { data: Buffer.from('EL') };
};
fake.post = async (url) => { log.push('ha-post ' + url); return { data: { path: '/api/tts_proxy/a.mp3' } }; };
fake.get = async (url) => { log.push('ha-get ' + url); return { data: Buffer.from('HA') }; };
require.cache[require.resolve('axios')] = { id: 'axios', loaded: true, exports: fake };

const tts = require('../lib/tts-service');
tts.setAudioDir(fs.mkdtempSync(path.join(os.tmpdir(), 'tts-')));

function quotaError() {
  const e = new Error('Request failed with status code 401');
  e.response = { status: 401, data: Buffer.from('{"detail":{"status":"quota_exceeded"}}') };
  return e;
}

test('ElevenLabs used while it works', async () => {
  log.length = 0; elevenFails = null; tts._resetPause();
  await tts.generateSpeech('Hallo');
  assert.deepStrictEqual(log, ['eleven']);
});

test('quota exceeded → Home Assistant, then ElevenLabs paused', async () => {
  log.length = 0; elevenFails = quotaError(); tts._resetPause();
  const url = await tts.generateSpeech('Hallo');
  assert.match(url, /audio-files\/tts-/);
  assert.deepStrictEqual(log, ['eleven', 'ha-post http://ha.test/api/tts_get_url', 'ha-get http://ha.test/api/tts_proxy/a.mp3']);
  log.length = 0;
  await tts.generateSpeech('Nochmal');
  assert.ok(!log.includes('eleven'), 'ElevenLabs skipped while paused');
});

test('other ElevenLabs error → Home Assistant this time, no pause', async () => {
  log.length = 0; elevenFails = new Error('timeout'); tts._resetPause();
  await tts.generateSpeech('Hallo');
  elevenFails = null; log.length = 0;
  await tts.generateSpeech('Hallo');
  assert.deepStrictEqual(log, ['eleven']);
});
