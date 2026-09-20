#!/usr/bin/env node
/**
 * Regenerates voice-app/config/devices.json from .env.
 *
 * .env only describes a single device's SIP identity (SIP_EXTENSION/
 * SIP_AUTH_ID/SIP_PASSWORD) and voice (ELEVENLABS_VOICE_ID) - it has no
 * "name" or "prompt" fields. Those are preserved from the existing
 * devices.json entry (or a default is used if the entry is new), so
 * re-running this never wipes out a hand-written personality prompt.
 *
 * Usage: node scripts/generate-devices-json.js
 */

const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", "..", ".env");
const DEVICES_PATH = path.join(__dirname, "..", "config", "devices.json");

// Minimal .env parser (KEY=VALUE per line, '#' comments, no quoting/escaping
// support) - avoids requiring the dotenv package to run this script standalone
// on the host, where voice-app's node_modules aren't installed.
function parseEnv(filePath) {
  const env = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = parseEnv(ENV_PATH);

const extension = env.SIP_EXTENSION;
const authId = env.SIP_AUTH_ID;
const password = env.SIP_PASSWORD;
const voiceId = env.ELEVENLABS_VOICE_ID;

if (!extension || !authId || !password) {
  console.error("Missing SIP_EXTENSION / SIP_AUTH_ID / SIP_PASSWORD in .env - nothing to generate.");
  process.exit(1);
}

let devices = {};
if (fs.existsSync(DEVICES_PATH)) {
  devices = JSON.parse(fs.readFileSync(DEVICES_PATH, "utf8"));
}

const existing = devices[extension] || {};

devices[extension] = {
  name: existing.name || "Morpheus",
  extension,
  authId,
  password,
  voiceId: voiceId || existing.voiceId,
  prompt: existing.prompt ||
    "You are Morpheus, a helpful AI assistant. Keep voice responses under 40 words.",
};

fs.writeFileSync(DEVICES_PATH, JSON.stringify(devices, null, 2) + "\n");

console.log(`Wrote ${DEVICES_PATH}`);
console.log(`  Device ${extension}: authId=${authId}, voiceId=${devices[extension].voiceId || "(none)"}`);
