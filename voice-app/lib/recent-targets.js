/**
 * Recent Targets
 * Remembers the numbers the operator put callers through to, so a silent
 * caller can hear "zuletzt gewählt: …". Kept per caller extension plus a
 * global list, persisted as JSON (survives container restarts when
 * RECENT_TARGETS_FILE lies on a volume). Write errors only cost persistence.
 */

const fs = require('fs');
const path = require('path');

const FILE = process.env.RECENT_TARGETS_FILE || '/app/data/recent-targets.json';
const KEEP = 10;

function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

let state = null; // { global: [nummer...], byCaller: { ext: [nummer...] } }

function load(file = FILE) {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    state = {};
  }
  if (!Array.isArray(state.global)) state.global = [];
  if (!state.byCaller || typeof state.byCaller !== 'object') state.byCaller = {};
  return state;
}

function push(list, nummer) {
  const out = [nummer, ...(list || []).filter(n => n !== nummer)];
  return out.slice(0, KEEP);
}

/** Record a successful transfer. */
function record(callerId, nummer, file = FILE) {
  const s = load(file);
  nummer = String(nummer);
  s.global = push(s.global, nummer);
  if (callerId) s.byCaller[callerId] = push(s.byCaller[callerId], nummer);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(s, null, 2));
  } catch (err) {
    log('RECENT-TARGETS not saved (' + file + '): ' + err.message);
  }
}

/**
 * Up to `count` recent numbers: this caller's first, then the global list,
 * then `fillers` (e.g. agents) so a fresh install still has suggestions.
 * Emergency numbers and the caller's own extension are never suggested.
 */
function recent(callerId, count = 5, fillers = [], file = FILE) {
  const s = load(file);
  const skip = new Set(['110', '112', String(callerId || '')]);
  const out = [];
  for (const n of [...(s.byCaller[callerId] || []), ...s.global, ...fillers.map(String)]) {
    if (out.length >= count) break;
    if (!skip.has(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

function _reset() { state = null; }

module.exports = { record, recent, _reset, FILE };
