/**
 * PBX Directory
 * Fetches the live phone book (Nummernplan) from the FreePBX box so the
 * operator knows every dialable target. Cached for a few minutes; on
 * error the caller falls back to the static directory from the config.
 *
 * Endpoint (LAN, no login): GET <PBX_DIRECTORY_URL>
 *   {"stand": "...", "regeln": ["..."], "ziele": [{nummer, name, art, beschreibung}]}
 */

const axios = require('axios');

const DEFAULT_URL = 'http://192.168.188.42/nummernplan/telefonbuch.json';
const TIMEOUT_MS = 2000;
const CACHE_MS = 5 * 60 * 1000;

let cache = null; // { at, data }

function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

function url() {
  return process.env.PBX_DIRECTORY_URL || DEFAULT_URL;
}

function validate(data) {
  if (!data || !Array.isArray(data.ziele)) throw new Error('kein "ziele"-Array in der Antwort');
  const ziele = data.ziele.filter(z => z && z.nummer && z.name)
    .map(z => ({
      nummer: String(z.nummer).trim(),
      name: String(z.name).trim(),
      art: z.art ? String(z.art) : '',
      beschreibung: z.beschreibung ? String(z.beschreibung).trim() : ''
    }));
  if (ziele.length === 0) throw new Error('Telefonbuch ist leer');
  return {
    stand: data.stand || '',
    regeln: Array.isArray(data.regeln) ? data.regeln.map(String) : [],
    ziele
  };
}

/**
 * @returns {Promise<{stand, regeln, ziele}|null>} null if the PBX is unreachable
 *   and nothing is cached (a stale cache is preferred over nothing).
 */
async function fetchDirectory(opts = {}) {
  const now = Date.now();
  if (!opts.force && cache && now - cache.at < CACHE_MS) return cache.data;
  try {
    const res = await (opts.http || axios).get(url(), { timeout: TIMEOUT_MS });
    const data = validate(res.data);
    cache = { at: now, data };
    log('PBX-DIRECTORY loaded ' + data.ziele.length + ' Ziele from ' + url() + ' (Stand ' + data.stand + ')');
    return data;
  } catch (err) {
    log('PBX-DIRECTORY fetch failed (' + url() + '): ' + err.message +
      (cache ? ' – using stale cache' : ' – falling back to static directory'));
    return cache ? cache.data : null;
  }
}

/**
 * Phone book text: PBX targets first, then own devices / static directory
 * entries whose number the PBX does not know (PBX wins on duplicates).
 * @param {object|null} pbx   result of fetchDirectory()
 * @param {object} devices    deviceRegistry.getAll()
 * @param {object} directory  deviceRegistry.getDirectory()  { ext: name }
 * @param {string} selfExtension operator's own extension (skipped)
 */
function buildText(pbx, devices, directory, selfExtension) {
  const lines = [];
  const seen = new Set([String(selfExtension)]);
  const add = (nummer, name, beschreibung) => {
    nummer = String(nummer);
    if (seen.has(nummer)) return;
    seen.add(nummer);
    lines.push('- ' + nummer + ': ' + name + (beschreibung ? ' – ' + beschreibung : ''));
  };

  if (pbx) for (const z of pbx.ziele) add(z.nummer, z.name, z.beschreibung);
  for (const d of Object.values(devices || {})) add(d.extension, d.name, d.description);
  // the static list is only a fallback – with a live PBX book it is noise
  if (!pbx) for (const [ext, name] of Object.entries(directory || {})) add(ext, name);

  if (pbx && pbx.regeln.length) {
    lines.push('', 'Regeln:');
    for (const r of pbx.regeln) lines.push('- ' + r);
  }
  return lines.join('\n');
}

function _resetCache() { cache = null; }

module.exports = { fetchDirectory, buildText, DEFAULT_URL, _resetCache };
