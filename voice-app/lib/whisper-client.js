/**
 * Speech-to-Text client
 * Converts audio buffers (L16 PCM from FreeSWITCH) to text.
 *
 * STT_PROVIDER=openai (default)  OpenAI Whisper, needs OPENAI_API_KEY
 * STT_PROVIDER=homeassistant     Home Assistant's STT API (e.g. Home Assistant
 *                                Cloud), needs HA_URL + HA_TOKEN; provider entity
 *                                via HA_STT_PROVIDER (default stt.home_assistant_cloud)
 */

const axios = require("axios");
const OpenAI = require("openai");
const WaveFile = require("wavefile").WaveFile;
const fs = require("fs");
const path = require("path");

// Lazy-initialized OpenAI client
let openai = null;

function getOpenAIClient() {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      console.warn("[WHISPER] OPENAI_API_KEY not set - STT will not work");
      return null;
    }
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      // No retries: on the phone a quick, clear error beats 30s of silence
      // (the SDK retries 429 "no credits" and then reports "Connection error")
      maxRetries: 0,
      timeout: 20000
    });
  }
  return openai;
}

/**
 * Convert L16 PCM buffer to WAV format for Whisper API
 * @param {Buffer} pcmBuffer - Raw L16 PCM audio data
 * @param {number} sampleRate - Sample rate (default: 8000 Hz for telephony)
 * @returns {Buffer} WAV file buffer
 */
function pcmToWav(pcmBuffer, sampleRate = 8000) {
  const wav = new WaveFile();

  // Convert Buffer to Int16Array for wavefile library
  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);

  // Create WAV from raw PCM data
  wav.fromScratch(1, sampleRate, "16", samples);

  return Buffer.from(wav.toBuffer());
}

/**
 * Transcribe audio using OpenAI Whisper API
 * @param {Buffer} audioBuffer - Audio data (either WAV or raw PCM)
 * @param {Object} options - Transcription options
 * @param {string} options.format - Input format: "wav" or "pcm" (default: "pcm")
 * @param {number} options.sampleRate - Sample rate for PCM (default: 8000)
 * @param {string} options.language - Language code (default: "de")
 * @returns {Promise<string>} Transcribed text
 */
async function transcribe(audioBuffer, options = {}) {
  if (process.env.STT_PROVIDER === "homeassistant") {
    return transcribeHomeAssistant(audioBuffer, options);
  }

  const {
    format = "pcm",
    sampleRate = 8000,
    language = "de"
  } = options;

  const client = getOpenAIClient();
  if (!client) {
    throw new Error("OpenAI API key not configured");
  }

  // Convert PCM to WAV if needed
  let wavBuffer;
  if (format === "pcm") {
    wavBuffer = pcmToWav(audioBuffer, sampleRate);
  } else {
    wavBuffer = audioBuffer;
  }

  // Write to temp file (Whisper API requires a file)
  const tempFile = path.join("/tmp", "whisper-" + Date.now() + ".wav");
  fs.writeFileSync(tempFile, wavBuffer);

  try {
    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempFile),
      model: "whisper-1",
      language: language,
      response_format: "text"
    });

    const timestamp = new Date().toISOString();
    console.log("[" + timestamp + "] WHISPER Transcribed: " + transcription.substring(0, 100) + (transcription.length > 100 ? "..." : ""));

    return transcription;
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tempFile);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Transcribe via Home Assistant's STT API (POST /api/stt/<provider>)
 */
async function transcribeHomeAssistant(audioBuffer, options = {}) {
  const { format = "pcm", sampleRate = 8000, language = "de" } = options;
  const { HA_URL, HA_TOKEN } = process.env;
  const provider = process.env.HA_STT_PROVIDER || "stt.home_assistant_cloud";
  if (!HA_URL || !HA_TOKEN) {
    throw new Error("HA_URL/HA_TOKEN not configured");
  }

  const wavBuffer = format === "pcm" ? pcmToWav(audioBuffer, sampleRate) : audioBuffer;
  const locale = language.includes("-") ? language : language + "-" + language.toUpperCase();

  let res;
  try {
    res = await axios.post(HA_URL.replace(/\/$/, "") + "/api/stt/" + provider, wavBuffer, {
      timeout: 20000,
      headers: {
        Authorization: "Bearer " + HA_TOKEN,
        "Content-Type": "audio/wav",
        "X-Speech-Content": "format=wav; codec=pcm; sample_rate=" + sampleRate +
          "; bit_rate=16; channel=1; language=" + locale
      }
    });
  } catch (err) {
    // Same shape as OpenAI errors, so callers can report status/code
    const e = new Error("Home Assistant STT failed: " + (err.response ? "HTTP " + err.response.status : err.message));
    e.status = err.response && err.response.status;
    e.code = err.code;
    throw e;
  }

  if (!res.data || res.data.result !== "success") {
    throw new Error("Home Assistant STT: " + JSON.stringify(res.data));
  }
  const text = res.data.text || "";
  console.log("[" + new Date().toISOString() + "] STT (" + provider + ") Transcribed: " + text.substring(0, 100));
  return text;
}

/**
 * Check if speech-to-text is configured and available
 * @returns {boolean} True if the selected provider has its credentials
 */
function isAvailable() {
  if (process.env.STT_PROVIDER === "homeassistant") {
    return !!(process.env.HA_URL && process.env.HA_TOKEN);
  }
  return !!process.env.OPENAI_API_KEY;
}

module.exports = {
  transcribe,
  pcmToWav,
  isAvailable
};
