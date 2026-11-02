/**
 * Call Session
 * Building blocks for inbound call flows: say, listen, ask Claude, transfer.
 * Extension handlers (extension-handlers.js) compose these per extension type.
 */

const { setTimeout: sleep } = require('node:timers/promises');

// Audio cue URLs
const READY_BEEP_URL = 'http://127.0.0.1:3000/static/ready-beep.wav';
const GOTIT_BEEP_URL = 'http://127.0.0.1:3000/static/gotit-beep.wav';
const HOLD_MUSIC_URL = 'http://127.0.0.1:3000/static/hold-music.mp3';

// Default voice ID (Morpheus)
const DEFAULT_VOICE_ID = 'JAgnJveGGUh4qy4kh6dF';

// Claude Code-style thinking phrases
const THINKING_PHRASES = [
  "Grübeln...",
  "Nachdenken...",
  "Überlegen...",
  "Sinnieren...",
  "Am Abwägen...",
  "Orakel befragen...",
  "Wissen beschwören...",
  "Neuronale Pfade aktivieren...",
  "Zugriff auf den Mainframe...",
  "Die Leere befragen...",
  "Lass mich kurz überlegen...",
  "Verarbeite...",
  "Hmm, interessante Frage...",
  "Einen Moment...",
  "Ich durchsuche mein Gehirn...",
];

function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

function getRandomThinkingPhrase() {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
}

function isGoodbye(transcript) {
  const lower = transcript.toLowerCase().trim();
  const goodbyePhrases = ['goodbye', 'good bye', 'bye', 'hang up', 'end call', "that's all", 'thats all', 'tschüss', 'auf wiederhören', 'auf wiedersehen', 'das wars', "das war's"];
  return goodbyePhrases.some(function(phrase) {
    return lower === phrase || lower.includes(' ' + phrase) ||
           lower.startsWith(phrase + ' ') || lower.endsWith(' ' + phrase);
  });
}

/**
 * Simple yes/no detection for confirmations (e.g. "Rechner starten?")
 * @returns {boolean|null} true = yes, false = no, null = unclear
 */
function parseYesNo(transcript) {
  const lower = transcript.toLowerCase();
  if (/\b(nein|nee|nö|lieber nicht|nicht|no)\b/.test(lower)) return false;
  if (/\b(ja|jo|jep|gerne|bitte|klar|okay|ok|mach|starte?n?|yes|sicher)\b/.test(lower)) return true;
  return null;
}

/**
 * Extract voice-friendly line from Claude's response
 * Priority: VOICE_RESPONSE > CUSTOM COMPLETED > COMPLETED > first sentence
 */
function extractVoiceLine(response) {
  // Priority 1: VOICE_RESPONSE (new format)
  var voiceMatch = response.match(/🗣️\s*VOICE_RESPONSE:\s*([^\n]+)/im);
  if (voiceMatch) {
    var text = voiceMatch[1].trim().replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
    if (text && text.split(/\s+/).length <= 60) {
      return text;
    }
  }

  // Priority 2: CUSTOM COMPLETED
  var customMatch = response.match(/🗣️\s*CUSTOM\s+COMPLETED:\s*(.+?)(?:\n|$)/im);
  if (customMatch) {
    text = customMatch[1].trim().replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
    if (text && text.split(/\s+/).length <= 50) {
      return text;
    }
  }

  // Priority 3: COMPLETED
  var completedMatch = response.match(/🎯\s*COMPLETED:\s*(.+?)(?:\n|$)/im);
  if (completedMatch) {
    return completedMatch[1].trim().replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
  }

  // Priority 4: First sentence
  var firstSentence = response.split(/[.!?]/)[0];
  if (firstSentence && firstSentence.length < 500) {
    return firstSentence.trim();
  }

  return response.substring(0, 500).trim();
}

class CallSession {
  constructor({ endpoint, dialog, callUuid, options, device }) {
    this.endpoint = endpoint;
    this.dialog = dialog;
    this.callUuid = callUuid;
    this.options = options;
    this.device = device;
    this.voiceId = (device && device.voiceId) || DEFAULT_VOICE_ID;
    this.active = true;
    this.audio = null;
    this.forkRunning = false;
    this.usedApis = new Set();

    dialog.on('destroy', () => { this.active = false; });
  }

  /** Start audio fork (needed before listen()) */
  async startListening() {
    if (this.audio) return;
    const { audioForkServer, wsPort } = this.options;
    const wsUrl = 'ws://127.0.0.1:' + wsPort + '/' + encodeURIComponent(this.callUuid);
    const sessionPromise = audioForkServer.expectSession(this.callUuid, { timeoutMs: 10000 });

    await this.endpoint.forkAudioStart({ wsUrl: wsUrl, mixType: 'mono', sampling: '16k' });
    this.forkRunning = true;
    this.audio = await sessionPromise;
    log('AUDIO Fork connected');
  }

  async play(url) {
    if (!this.active) return;
    try {
      await this.endpoint.play(url);
    } catch (e) {
      log('PLAY failed, continuing: ' + e.message);
    }
  }

  async say(text) {
    if (!this.active) return;
    log('SAY: "' + text + '"');
    const url = await this.options.ttsService.generateSpeech(text, this.voiceId);
    await this.play(url);
  }

  /** Background hold music, stopped by stopHoldMusic() */
  startHoldMusic() {
    if (!this.active) return;
    this.endpoint.play(HOLD_MUSIC_URL).catch(function() {
      log('MUSIC: Hold music failed, continuing');
    });
  }

  async stopHoldMusic() {
    try {
      await this.endpoint.api('uuid_break', this.endpoint.uuid);
    } catch (e) {}
  }

  /**
   * Wait for one utterance and transcribe it.
   * @returns {Promise<string|null>} transcript, or null on silence/unclear
   */
  async listen({ timeoutMs = 30000 } = {}) {
    await this.startListening();
    await this.play(READY_BEEP_URL);
    if (!this.active) return null;

    this.audio.setCaptureEnabled(true);
    log('LISTEN Waiting for speech...');
    let utterance = null;
    try {
      utterance = await this.audio.waitForUtterance({ timeoutMs });
    } catch (err) {
      log('LISTEN Timeout: ' + err.message);
    }
    this.audio.setCaptureEnabled(false);
    if (!utterance || !this.active) return null;

    await this.play(GOTIT_BEEP_URL);
    const transcript = await this.options.whisperClient.transcribe(utterance.audio, {
      format: 'pcm',
      sampleRate: 16000
    });
    log('WHISPER: "' + transcript + '"');
    return transcript && transcript.trim().length >= 2 ? transcript : null;
  }

  /** Ask a claude-api-server, with thinking phrase + hold music */
  async askClaude(apiUrl, transcript, { devicePrompt, timeout } = {}) {
    this.usedApis.add(apiUrl);

    // THINKING FEEDBACK
    // Capped at 3s: ElevenLabs occasionally "hallucinates" an oversized
    // clip (10+ seconds) for short filler phrases. Waiting for the full
    // clip in that case would leave the caller in dead air, so we give up
    // waiting after 3s and move on (the clip keeps playing in the background).
    const thinkingUrl = await this.options.ttsService.generateSpeech(getRandomThinkingPhrase(), this.voiceId);
    if (this.active) {
      await Promise.race([this.play(thinkingUrl), sleep(3000)]);
    }
    this.startHoldMusic();

    const response = await this.options.claudeBridge.query(transcript, {
      callId: this.callUuid,
      devicePrompt: devicePrompt,
      apiUrl: apiUrl,
      timeout: timeout
    });

    await this.stopHoldMusic();
    return response;
  }

  /**
   * Multi-turn conversation with a claude-api-server.
   * @param {Function} [opts.onResponse] - (response) => 'continue' | 'stop'
   */
  async converse(apiUrl, { greeting, devicePrompt, timeout, maxTurns = 20, onResponse } = {}) {
    if (greeting) await this.say(greeting);

    let turn = 0;
    while (turn < maxTurns && this.active) {
      turn++;
      log('CONVERSATION Turn ' + turn + '/' + maxTurns + ' (' + apiUrl + ')');

      const transcript = await this.listen();
      if (!this.active) break;
      if (!transcript) {
        await this.say("Ich habe nichts verstanden. Bist du noch da?");
        continue;
      }

      if (isGoodbye(transcript)) {
        await this.say("Auf Wiederhören! Ruf gerne jederzeit wieder an.");
        return;
      }

      const response = await this.askClaude(apiUrl, transcript, { devicePrompt, timeout });
      if (!this.active) break;

      await this.say(extractVoiceLine(response));
      if (onResponse && (await onResponse(response)) === 'stop') return;
    }

    if (turn >= maxTurns && this.active) {
      await this.say("Wir haben jetzt schon eine Weile gesprochen. Auf Wiederhören!");
    }
  }

  /**
   * Blind transfer via SIP REFER. The PBX takes over the caller and
   * hangs up our leg once the transfer succeeds.
   */
  async transfer(target) {
    const domain = (this.device && this.device.sipDomain) || process.env.SIP_DOMAIN;
    const referTo = '<sip:' + target + '@' + domain + '>';
    log('TRANSFER ' + this.callUuid + ' -> ' + referTo);

    const res = await this.dialog.request({
      method: 'REFER',
      headers: {
        'Refer-To': referTo,
        'Referred-By': '<sip:' + this.device.extension + '@' + domain + '>'
      }
    });
    if (res.status !== 202 && res.status !== 200) {
      throw new Error('REFER rejected: ' + res.status + ' ' + res.reason);
    }
    // Give the PBX time to pick up the caller before we tear down
    await sleep(5000);
  }

  async close() {
    for (const apiUrl of this.usedApis) {
      try { await this.options.claudeBridge.endSession(this.callUuid, apiUrl); } catch (e) {}
    }
    if (this.forkRunning) {
      try { await this.endpoint.forkAudioStop(); } catch (e) {}
    }
    try { this.dialog.destroy(); } catch (e) {}
  }
}

module.exports = { CallSession, extractVoiceLine, isGoodbye, parseYesNo, sleep };
