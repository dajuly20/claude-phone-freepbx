/**
 * Claude HTTP API Bridge
 * HTTP client for Claude API server with session management
 */

const axios = require('axios');

const CLAUDE_API_URL = process.env.CLAUDE_API_URL || 'http://localhost:3333';

/**
 * Query Claude via HTTP API with session support
 * @param {string} prompt - The prompt/question to send to Claude
 * @param {Object} options - Options including callId for session management
 * @param {string} options.callId - Call UUID for maintaining conversation context
 * @param {string} options.devicePrompt - Device-specific personality prompt
 * @param {number} options.timeout - Timeout in seconds (default: 30, AC27)
 * @returns {Promise<string>} Claude's response
 */
async function query(prompt, options = {}) {
  const { callId, devicePrompt, timeout = 30 } = options; // AC27: Default 30s timeout
  const timestamp = new Date().toISOString();

  try {
    console.log(`[${timestamp}] CLAUDE Sending query to ${CLAUDE_API_URL}...`);
    if (callId) {
      console.log(`[${timestamp}] CLAUDE Session: ${callId}`);
    }
    if (devicePrompt) {
      console.log(`[${timestamp}] CLAUDE Device prompt: ${devicePrompt.substring(0, 50)}...`);
    }

    const response = await axios.post(
      `${CLAUDE_API_URL}/ask`,
      { prompt, callId, devicePrompt },
      {
        timeout: timeout * 1000,
        headers: { 'Content-Type': 'application/json' }
      }
    );

    if (!response.data.success) {
      throw new Error(response.data.error || 'Claude API returned failure');
    }

    console.log(`[${timestamp}] CLAUDE Response received (${response.data.duration_ms}ms)`);
    if (response.data.sessionId) {
      console.log(`[${timestamp}] CLAUDE Session ID: ${response.data.sessionId}`);
    }
    return response.data.response;

  } catch (error) {
    // AC26: API server unreachable during call - don't crash, return helpful message
    if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH') {
      console.warn(`[${timestamp}] CLAUDE API server unreachable (${error.code})`);
      return "Ich habe gerade Verbindungsprobleme zu meinem Gehirn. Der API-Server ist eventuell offline. Bitte versuch es später nochmal.";
    }

    // AC27: Timeout with helpful error message
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      console.error(`[${timestamp}] CLAUDE Timeout after ${timeout} seconds`);
      return "Entschuldigung, das hat zu lange gedauert. Vielleicht ist der API-Server langsam oder es gibt ein Netzwerkproblem. Versuch etwas Einfacheres oder prüfe, ob claude-phone api-server läuft.";
    }

    console.error(`[${timestamp}] CLAUDE Error:`, error.message);
    // AC26: Don't crash on unknown errors, return friendly message
    return "Es ist ein unerwarteter Fehler aufgetreten. Bitte prüfe, ob claude-phone api-server läuft und im gleichen Netzwerk erreichbar ist.";
  }
}

/**
 * End a Claude session when a call ends
 * @param {string} callId - The call UUID to end the session for
 */
async function endSession(callId) {
  if (!callId) return;
  
  const timestamp = new Date().toISOString();
  
  try {
    await axios.post(
      `${CLAUDE_API_URL}/end-session`,
      { callId },
      { 
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    console.log(`[${timestamp}] CLAUDE Session ended: ${callId}`);
  } catch (error) {
    // Non-critical, just log
    console.warn(`[${timestamp}] CLAUDE Failed to end session: ${error.message}`);
  }
}

/**
 * Check if Claude API is available
 * @returns {Promise<boolean>} True if API is reachable
 */
async function isAvailable() {
  try {
    await axios.get(`${CLAUDE_API_URL}/health`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  query,
  endSession,
  isAvailable
};
