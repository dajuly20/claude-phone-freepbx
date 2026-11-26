/**
 * Text-to-Speech Service
 * Generates speech audio files and returns URLs for FreeSWITCH playback.
 *
 * ElevenLabs first; if that fails (quota used up, key invalid, outage) the
 * same text goes to Home Assistant TTS (default tts.home_assistant_cloud).
 * After a quota/auth error ElevenLabs is skipped for TTS_ELEVENLABS_PAUSE_MIN
 * minutes (default 30) so calls don't wait for a request that will fail.
 *   TTS_FALLBACK=homeassistant|none   HA_TTS_ENGINE, HA_TTS_LANGUAGE, HA_TTS_VOICE
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

// Default voice IDs (can be customized)
const DEFAULT_VOICE_ID = 'JAgnJveGGUh4qy4kh6dF'; // Morpheus voice
const MODEL_ID = 'eleven_turbo_v2_5'; // Fast, low-latency, multilingual model

// Audio output directory (set via setAudioDir)
let audioDir = path.join(__dirname, '../audio-temp');

/**
 * Set the audio output directory
 * @param {string} dir - Absolute path to audio directory
 */
function setAudioDir(dir) {
  audioDir = dir;

  // Create directory if it doesn't exist
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
    logger.info('Created audio directory', { path: audioDir });
  }
}

/**
 * Generate unique filename for audio file
 * @param {string} text - Text being converted
 * @returns {string} Filename (without path)
 */
function generateFilename(text) {
  // Hash text to create unique identifier
  const hash = crypto.createHash('md5').update(text).digest('hex').substring(0, 8);
  const timestamp = Date.now();
  return `tts-${timestamp}-${hash}.mp3`;
}

/**
 * Convert text to speech using ElevenLabs API
 * @param {string} text - Text to convert to speech
 * @param {string} voiceId - ElevenLabs voice ID (optional)
 * @returns {Promise<string>} HTTP URL to audio file
 */
const PAUSE_MS = (Number(process.env.TTS_ELEVENLABS_PAUSE_MIN) || 30) * 60000;
let elevenLabsPausedUntil = 0;

function saveAudio(text, data) {
  const filename = generateFilename(text);
  fs.writeFileSync(path.join(audioDir, filename), data);
  return `http://127.0.0.1:3000/audio-files/${filename}`;
}

/** Home Assistant TTS: POST /api/tts_get_url, then fetch the MP3 */
async function generateSpeechHA(text) {
  const { HA_URL, HA_TOKEN } = process.env;
  if (!HA_URL || !HA_TOKEN) throw new Error('HA_URL/HA_TOKEN not configured');
  const base = HA_URL.replace(/\/$/, '');
  const headers = { Authorization: 'Bearer ' + HA_TOKEN };
  const startTime = Date.now();
  const body = {
    engine_id: process.env.HA_TTS_ENGINE || 'tts.home_assistant_cloud',
    message: text,
    language: process.env.HA_TTS_LANGUAGE || 'de-DE'
  };
  if (process.env.HA_TTS_VOICE) body.options = { voice: process.env.HA_TTS_VOICE };
  const res = await axios.post(base + '/api/tts_get_url', body, { headers, timeout: 15000 });
  const audio = await axios.get(base + res.data.path, { headers, timeout: 15000, responseType: 'arraybuffer' });
  const url = saveAudio(text, audio.data);
  logger.info('Speech generation successful (Home Assistant)', {
    engine: body.engine_id, latency: Date.now() - startTime, textLength: text.length
  });
  return url;
}

/**
 * Speech for `text`: ElevenLabs, falling back to Home Assistant TTS
 * @returns {Promise<string>} HTTP URL to audio file
 */
async function generateSpeech(text, voiceId = DEFAULT_VOICE_ID) {
  const fallback = (process.env.TTS_FALLBACK || 'homeassistant') !== 'none';
  if (fallback && Date.now() < elevenLabsPausedUntil) return generateSpeechHA(text);
  try {
    return await generateSpeechElevenLabs(text, voiceId);
  } catch (err) {
    if (!fallback) throw err;
    if (err.pauseElevenLabs) {
      elevenLabsPausedUntil = Date.now() + PAUSE_MS;
      logger.warn('ElevenLabs paused, using Home Assistant TTS', { minutes: PAUSE_MS / 60000, reason: err.message });
    }
    try {
      return await generateSpeechHA(text);
    } catch (haErr) {
      logger.error('Home Assistant TTS failed too', { error: haErr.message });
      throw err;
    }
  }
}

async function generateSpeechElevenLabs(text, voiceId = DEFAULT_VOICE_ID) {
  const startTime = Date.now();

  try {
    if (!ELEVENLABS_API_KEY) {
      throw new Error('ELEVENLABS_API_KEY environment variable not set');
    }

    logger.info('Generating speech with ElevenLabs', {
      textLength: text.length,
      voiceId,
      model: MODEL_ID
    });

    // Call ElevenLabs API
    const response = await axios({
      method: 'POST',
      url: `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}`,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      data: {
        text,
        model_id: MODEL_ID,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true
        }
      },
      responseType: 'arraybuffer'
    });

    const audioUrl = saveAudio(text, response.data);

    const latency = Date.now() - startTime;
    const fileSize = response.data.length;

    logger.info('Speech generation successful', {
      fileSize,
      latency,
      textLength: text.length
    });

    return audioUrl;

  } catch (error) {
    const latency = Date.now() - startTime;

    logger.error('Speech generation failed', {
      error: error.message,
      latency,
      textLength: text?.length,
      responseStatus: error.response?.status,
      responseData: error.response?.data?.toString()
    });

    // Handle specific errors
    const status = error.response?.status;
    if (!ELEVENLABS_API_KEY || status === 401 || status === 402 ||
        /quota/i.test(String(error.response?.data || ''))) {
      const e = new Error(!ELEVENLABS_API_KEY ? 'ElevenLabs API key missing'
        : /quota/i.test(String(error.response?.data || '')) ? 'ElevenLabs quota exceeded'
          : 'ElevenLabs API authentication failed - check API key');
      e.pauseElevenLabs = true;
      throw e;
    } else if (status === 429) {
      throw new Error('ElevenLabs API rate limit exceeded');
    } else if (error.response?.status === 400) {
      throw new Error('Invalid request to ElevenLabs API');
    }

    throw new Error(`TTS generation failed: ${error.message}`);
  }
}

/**
 * Clean up old audio files (older than specified age)
 * @param {number} maxAgeMs - Maximum age in milliseconds (default: 1 hour)
 */
function cleanupOldFiles(maxAgeMs = 60 * 60 * 1000) {
  try {
    const now = Date.now();
    const files = fs.readdirSync(audioDir);

    let deletedCount = 0;
    files.forEach(file => {
      if (!file.startsWith('tts-') || !file.endsWith('.mp3')) {
        return;
      }

      const filepath = path.join(audioDir, file);
      const stats = fs.statSync(filepath);
      const age = now - stats.mtimeMs;

      if (age > maxAgeMs) {
        fs.unlinkSync(filepath);
        deletedCount++;
      }
    });

    if (deletedCount > 0) {
      logger.info('Cleaned up old audio files', { deletedCount });
    }

  } catch (error) {
    logger.warn('Failed to cleanup old audio files', { error: error.message });
  }
}

/**
 * Get list of available ElevenLabs voices
 * @returns {Promise<Array>} Array of voice objects
 */
async function getAvailableVoices() {
  try {
    if (!ELEVENLABS_API_KEY) {
      throw new Error('ELEVENLABS_API_KEY environment variable not set');
    }

    const response = await axios({
      method: 'GET',
      url: `${ELEVENLABS_API_URL}/voices`,
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY
      }
    });

    return response.data.voices;

  } catch (error) {
    logger.error('Failed to fetch available voices', { error: error.message });
    throw error;
  }
}

// Initialize audio directory
setAudioDir(audioDir);

// Setup periodic cleanup (every 30 minutes)
setInterval(() => {
  cleanupOldFiles();
}, 30 * 60 * 1000).unref();

function _resetPause() { elevenLabsPausedUntil = 0; }

module.exports = {
  generateSpeech,
  generateSpeechHA,
  _resetPause,
  setAudioDir,
  cleanupOldFiles,
  getAvailableVoices
};
