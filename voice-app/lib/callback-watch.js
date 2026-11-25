/* global Intl */
/**
 * Callback Watch – Rückrufe für alle Nebenstellen.
 * Places an announce call via the existing outbound API, either
 *   - at a time: minutes (from now) or at ("HH:MM" Berlin time or ISO), or
 *   - when a Home Assistant entity (state or one attribute) changes INTO
 *     one of the wanted values ("ruf mich an, wenn der Staubsauger losfährt").
 * `to` may be any number the PBX can dial (extension, Wählnummer, 0…, +49…).
 *
 *   POST   /api/callback-watch   { to, message, device?,
 *                                  minutes? | at? |
 *                                  entity, values: [..] | "a,b", attribute?, hours? (default 3) }
 *   GET    /api/callback-watch   active watches
 *   DELETE /api/callback-watch/:id
 *
 * Only a change counts: if the value already matches when the watch starts,
 * it waits until it has left and comes back. Watches live in memory (gone
 * after a restart) and expire after `hours`.
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const POLL_MS = Number(process.env.CALLBACK_POLL_MS) || 15000;
const MAX_WATCHES = 20;
const watches = new Map();
let timer = null;
let deps = { haGet: null, placeCall: null };

function log(msg) {
  console.log('[' + new Date().toISOString() + '] CALLBACK ' + msg);
}

/** Current value of an entity's state or attribute from Home Assistant */
async function defaultHaGet(entity, attribute) {
  const { HA_URL, HA_TOKEN } = process.env;
  if (!HA_URL || !HA_TOKEN) throw new Error('HA_URL/HA_TOKEN fehlen');
  const res = await axios.get(HA_URL.replace(/\/$/, '') + '/api/states/' + encodeURIComponent(entity), {
    timeout: 8000, headers: { Authorization: 'Bearer ' + HA_TOKEN }
  });
  const v = attribute ? (res.data.attributes || {})[attribute] : res.data.state;
  return v === undefined || v === null ? '' : String(v);
}

/** Announce call through our own outbound API */
async function defaultPlaceCall(w) {
  const port = Number(process.env.HTTP_PORT) || 3000;
  await axios.post('http://127.0.0.1:' + port + '/api/outbound-call',
    { to: w.to, message: w.message, mode: 'announce', device: w.device || undefined }, { timeout: 10000 });
}

/** "19:30" (Europe/Berlin, today or tomorrow) or an ISO timestamp → ms */
function parseAt(at, now = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at).trim());
  if (!m) {
    const t = Date.parse(at);
    if (Number.isNaN(t)) throw new Error('at ungültig (HH:MM oder ISO)');
    return t;
  }
  // Berlin offset right now (handles summer/winter time)
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const g = (t) => Number(parts.find(p => p.type === t).value);
  const berlinNowAsUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  const offset = berlinNowAsUtc - Math.floor(now / 60000) * 60000;
  let t = Date.UTC(g('year'), g('month') - 1, g('day'), Number(m[1]), Number(m[2])) - offset;
  if (t <= now) t += 86400000;
  return t;
}

function normalizeValues(values) {
  const list = Array.isArray(values) ? values : String(values || '').split(',');
  return list.map(v => String(v).trim().toLowerCase()).filter(Boolean);
}

async function fire(w, why) {
  watches.delete(w.id);
  log(w.id + ' ' + why + ' → Anruf an ' + w.to);
  try {
    await deps.placeCall(w);
  } catch (err) {
    log(w.id + ' Anruf fehlgeschlagen: ' + err.message);
  }
}

async function checkOne(w) {
  if (w.due) {
    if (Date.now() >= w.due) await fire(w, 'Zeit erreicht');
    return;
  }
  if (Date.now() > w.expires) {
    log(w.id + ' abgelaufen (' + w.entity + ')');
    watches.delete(w.id);
    return;
  }
  let value;
  try {
    value = (await deps.haGet(w.entity, w.attribute)).toLowerCase();
  } catch (err) {
    log(w.id + ' HA-Fehler: ' + err.message);
    return;
  }
  const hit = w.values.includes(value);
  if (w.last === null) {                 // baseline
    w.last = value;
    w.armed = !hit;
    return;
  }
  if (!hit) w.armed = true;
  w.last = value;
  if (hit && w.armed) await fire(w, w.entity + (w.attribute ? '.' + w.attribute : '') + ' = ' + value);
}

async function pollAll() {
  for (const w of [...watches.values()]) await checkOne(w);
  if (!watches.size && timer) {
    clearInterval(timer);
    timer = null;
  }
}

const MAX_TIMER_MS = 7 * 86400000;

function add({ entity, values, to, message, attribute, device, hours, minutes, at }) {
  to = String(to || '').replace(/[\s/-]/g, '');
  if (!/^(\+[1-9]\d{1,14}|\d{1,15})$/.test(to)) throw new Error('to fehlt/ungültig');
  if (!message || String(message).length > 500) throw new Error('message fehlt/zu lang');
  if (watches.size >= MAX_WATCHES) throw new Error('zu viele Rückrufe aktiv');
  const base = { id: crypto.randomBytes(4).toString('hex'), to, message: String(message), device: device || '',
    created: new Date().toISOString() };
  let w;
  if (minutes !== undefined && minutes !== null && minutes !== '' || at) {
    const due = at ? parseAt(at) : Date.now() + Number(minutes) * 60000;
    if (!Number.isFinite(due) || due - Date.now() > MAX_TIMER_MS) throw new Error('Zeitpunkt ungültig (max. 7 Tage)');
    w = { ...base, due, expires: due };
    log(w.id + ' neu: um ' + new Date(due).toISOString() + ' Anruf an ' + to);
  } else {
    if (!/^[a-z_]+\.[a-z0-9_]+$/.test(String(entity || ''))) throw new Error('entity oder minutes/at fehlt');
    const vals = normalizeValues(values);
    if (!vals.length) throw new Error('values fehlt');
    const h = Math.min(Math.max(Number(hours) || 3, 0.1), 24);
    w = { ...base, entity, attribute: attribute || '', values: vals, expires: Date.now() + h * 3600000,
      last: null, armed: false };
    log(w.id + ' neu: ' + entity + (w.attribute ? '.' + w.attribute : '') + ' → ' + vals.join('/') +
      ', Anruf an ' + to + ' (' + h + ' h)');
  }
  watches.set(w.id, w);
  if (!timer) timer = setInterval(() => { pollAll().catch(() => {}); }, POLL_MS);
  checkOne(w).catch(() => {});        // baseline right away
  return w;
}

const router = express.Router();

router.post('/callback-watch', (req, res) => {
  try {
    const w = add(req.body || {});
    res.json({ success: true, id: w.id, expires: new Date(w.expires).toISOString() });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/callback-watch', (req, res) => {
  res.json([...watches.values()].map(w => ({ id: w.id, to: w.to, message: w.message,
    due: w.due ? new Date(w.due).toISOString() : undefined, entity: w.entity, attribute: w.attribute,
    values: w.values, last: w.last, armed: w.armed, expires: new Date(w.expires).toISOString() })));
});

router.delete('/callback-watch/:id', (req, res) => {
  res.json({ success: watches.delete(req.params.id) });
});

function setup(opts = {}) {
  deps = { haGet: opts.haGet || defaultHaGet, placeCall: opts.placeCall || defaultPlaceCall };
}
setup();

function _reset() {
  watches.clear();
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { router, setup, add, pollAll, checkOne, parseAt, _reset, watches };
