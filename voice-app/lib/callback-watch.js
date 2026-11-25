/**
 * Callback Watch
 * "Ruf mich an, wenn der Staubsauger losfährt": watches a Home Assistant
 * entity (state or one attribute) and places an announce call via the
 * existing outbound API as soon as it changes INTO one of the wanted values.
 *
 *   POST   /api/callback-watch   { entity, values: [..] | "a,b", to, message,
 *                                  attribute?, device?, hours? (default 3) }
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

function normalizeValues(values) {
  const list = Array.isArray(values) ? values : String(values || '').split(',');
  return list.map(v => String(v).trim().toLowerCase()).filter(Boolean);
}

async function checkOne(w) {
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
  if (hit && w.armed) {
    watches.delete(w.id);
    log(w.id + ' ' + w.entity + (w.attribute ? '.' + w.attribute : '') + ' = ' + value + ' → Anruf an ' + w.to);
    try {
      await deps.placeCall(w);
    } catch (err) {
      log(w.id + ' Anruf fehlgeschlagen: ' + err.message);
    }
  }
}

async function pollAll() {
  for (const w of [...watches.values()]) await checkOne(w);
  if (!watches.size && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function add({ entity, values, to, message, attribute, device, hours }) {
  if (!/^[a-z_]+\.[a-z0-9_]+$/.test(String(entity || ''))) throw new Error('entity fehlt/ungültig');
  const vals = normalizeValues(values);
  if (!vals.length) throw new Error('values fehlt');
  if (!/^\+?[0-9*#]{2,20}$/.test(String(to || ''))) throw new Error('to fehlt/ungültig');
  if (!message || String(message).length > 500) throw new Error('message fehlt/zu lang');
  if (watches.size >= MAX_WATCHES) throw new Error('zu viele Rückrufe aktiv');
  const h = Math.min(Math.max(Number(hours) || 3, 0.1), 24);
  const w = { id: crypto.randomBytes(4).toString('hex'), entity, attribute: attribute || '', values: vals,
    to: String(to), message: String(message), device: device || '', expires: Date.now() + h * 3600000,
    last: null, armed: false, created: new Date().toISOString() };
  watches.set(w.id, w);
  log(w.id + ' neu: ' + entity + (w.attribute ? '.' + w.attribute : '') + ' → ' + vals.join('/') +
    ', Anruf an ' + w.to + ' (' + h + ' h)');
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
  res.json([...watches.values()].map(w => ({ id: w.id, entity: w.entity, attribute: w.attribute,
    values: w.values, to: w.to, last: w.last, armed: w.armed, expires: new Date(w.expires).toISOString() })));
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

module.exports = { router, setup, add, pollAll, checkOne, _reset, watches };
