/**
 * Private address book (vCard export, e.g. from Google Contacts).
 *
 * The file is NOT part of the repo: it lives on the docker host in
 * ./private/contacts.vcf and is mounted read-only (CONTACTS_FILE).
 * Reloaded automatically when the file changes.
 *
 * Who may see what:
 *   - lookupNumber(): caller identification – an external caller's own
 *     number → name. Used for every call coming in from outside.
 *   - search(): full entries (numbers, mail, …) – only for the owner
 *     (isOwner(callerId), numbers from OWNER_CALLER_IDS in .env).
 */

const fs = require('fs');

const DEFAULT_FILE = '/app/private/contacts.vcf';
const COUNTRY_CODE = process.env.CONTACTS_COUNTRY_CODE || '49';

let cache = null; // { file, mtimeMs, contacts, byNumber }

function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

function file() {
  return process.env.CONTACTS_FILE || DEFAULT_FILE;
}

/** "+49 170 123", "0170/123", "0049170123" → "+49170123"; internal short numbers stay as they are */
function normalizeNumber(raw) {
  if (!raw) return '';
  let n = String(raw).trim().replace(/^tel:/i, '');
  const plus = n.startsWith('+');
  n = n.replace(/[^\d]/g, '');
  if (!n) return '';
  if (plus) return '+' + n;
  if (n.startsWith('00')) return '+' + n.slice(2);
  if (n.startsWith('0')) return '+' + COUNTRY_CODE + n.slice(1);
  return n; // extension like 222
}

/** Number as the PBX dials it: +49170… → 0170…, +41… → 0041… */
function dialable(e164) {
  if (!e164.startsWith('+')) return e164;
  if (e164.startsWith('+' + COUNTRY_CODE)) return '0' + e164.slice(1 + COUNTRY_CODE.length);
  return '00' + e164.slice(1);
}

function isExternal(callerId) {
  const n = normalizeNumber(callerId);
  return n.startsWith('+') && n.length > 6;
}

function unescape(v) {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

const TEL_TYPES = { CELL: 'Handy', HOME: 'privat', WORK: 'Arbeit', MAIN: 'Haupt', FAX: 'Fax', PAGER: 'Pager' };

function parse(text) {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const contacts = [];
  for (const block of unfolded.split(/^BEGIN:VCARD$/m).slice(1)) {
    const c = { name: '', org: '', numbers: [], emails: [], birthday: '', address: '', note: '' };
    for (const line of block.split('\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const head = line.slice(0, idx);
      const value = line.slice(idx + 1);
      const prop = head.split(';')[0].replace(/^item\d+\./i, '').toUpperCase();
      const typeMatch = head.toUpperCase().match(/TYPE=([A-Z,]+)/);
      const type = typeMatch ? typeMatch[1].split(',')[0] : '';
      if (prop === 'FN') c.name = unescape(value);
      else if (prop === 'N' && !c.name) c.name = unescape(value.split(';').slice(0, 2).reverse().join(' '));
      else if (prop === 'ORG') c.org = unescape(value.split(';')[0]);
      else if (prop === 'TEL') {
        const number = normalizeNumber(value);
        if (number) c.numbers.push({ number, type: TEL_TYPES[type] || '' });
      } else if (prop === 'EMAIL') c.emails.push(unescape(value));
      else if (prop === 'BDAY') c.birthday = value.trim();
      else if (prop === 'ADR' && !c.address) c.address = unescape(value.split(';').filter(Boolean).join(', '));
      else if (prop === 'NOTE') c.note = unescape(value).slice(0, 200);
    }
    if (!c.name) c.name = c.org;
    if (c.name || c.numbers.length) contacts.push(c);
  }
  return contacts;
}

function load() {
  const f = file();
  let stat;
  try {
    stat = fs.statSync(f);
  } catch (err) {
    if (!cache || cache.file !== f) log('CONTACTS no address book at ' + f + ' – caller identification off');
    cache = { file: f, mtimeMs: 0, contacts: [], byNumber: new Map() };
    return cache;
  }
  if (cache && cache.file === f && cache.mtimeMs === stat.mtimeMs) return cache;

  const contacts = parse(fs.readFileSync(f, 'utf8'));
  const byNumber = new Map();
  for (const c of contacts) {
    for (const { number } of c.numbers) if (!byNumber.has(number)) byNumber.set(number, c);
  }
  cache = { file: f, mtimeMs: stat.mtimeMs, contacts, byNumber };
  log('CONTACTS loaded ' + contacts.length + ' contacts (' + byNumber.size + ' numbers) from ' + f);
  return cache;
}

/** @returns {object|null} contact whose number matches the caller */
function lookupNumber(callerId) {
  const n = normalizeNumber(callerId);
  if (!n || !n.startsWith('+')) return null;
  return load().byNumber.get(n) || null;
}

/** Owner = Julian: own phones and mobile, from OWNER_CALLER_IDS (comma separated) */
function isOwner(callerId) {
  const n = normalizeNumber(callerId);
  if (!n) return false;
  return String(process.env.OWNER_CALLER_IDS || '').split(',')
    .map(normalizeNumber).filter(Boolean).includes(n);
}

// Words that say nothing about whom the caller wants
const STOPWORDS = new Set(('ich du er sie es wir ihr mich mir dich dir mit und oder der die das den dem des ' +
  'ein eine einen einem bitte mal kannst könntest würdest verbinde verbinden verbindest anrufen ruf rufe ' +
  'an zu zum zur von vom bei nach für auf handy nummer telefon festnetz arbeit privat möchte will gerne ' +
  'hallo hi guten tag sprechen erreichen herr frau hat ist was wie welche welcher wer wo').split(' '));

function fold(s) {
  return String(s).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/[^a-z0-9 ]+/g, ' ');
}

/**
 * Contacts whose name/organisation matches words of what the caller said.
 * @returns {object[]} best matches first
 */
function search(text, limit = 5) {
  const words = fold(text).split(/\s+/).filter(w => w.length >= 3 && !STOPWORDS.has(w));
  if (!words.length) return [];
  const scored = [];
  for (const c of load().contacts) {
    const tokens = fold(c.name + ' ' + c.org).split(/\s+/).filter(Boolean);
    let score = 0;
    for (const w of words) {
      if (tokens.includes(w)) score += 3;
      else if (w.length >= 4 && tokens.some(t => t.startsWith(w) || (t.length >= 4 && w.startsWith(t)))) score += 1;
    }
    if (score) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  const best = scored.length ? scored[0].score : 0;
  return scored.filter(s => s.score >= Math.min(best, 3)).slice(0, limit).map(s => s.c);
}

/** One prompt line per contact, numbers in dialable form */
function describe(c) {
  const parts = [c.name + (c.org && c.org !== c.name ? ' (' + c.org + ')' : '')];
  for (const { number, type } of c.numbers) parts.push((type ? type + ' ' : '') + dialable(number));
  if (c.emails.length) parts.push('E-Mail ' + c.emails.join(', '));
  if (c.birthday) parts.push('Geburtstag ' + c.birthday);
  if (c.address) parts.push('Adresse ' + c.address);
  if (c.note) parts.push('Notiz ' + c.note);
  return '- ' + parts.join(' · ');
}

/** Name for the caller-ID line: "Max Muster (Firma)" */
function callerName(c) {
  return c.name + (c.org && c.org !== c.name ? ' (' + c.org + ')' : '');
}

function _reset() { cache = null; }

module.exports = {
  normalizeNumber, dialable, isExternal, parse, lookupNumber, isOwner, search, describe, callerName,
  DEFAULT_FILE, _reset
};
