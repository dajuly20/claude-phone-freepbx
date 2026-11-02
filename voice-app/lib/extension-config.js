/**
 * Extension Config ("Telefonbuch")
 *
 * Loads the YAML phone book defined inline in docker-compose.yml
 * (configs.telefonbuch → /app/config/extensions.yml) and turns it into
 * device objects compatible with device-registry.
 *
 * Extension types:
 *   operator    - Claude switchboard, transfers via SIP REFER
 *   host        - check host, offer Wake-on-LAN, then talk to its Claude
 *   claude      - talk directly to a claude-api-server (agent URL)
 *   placeholder - speak a message and hang up
 */

const fs = require('fs');
const YAML = require('yaml');
const logger = require('./logger');

const CONFIG_PATH = process.env.EXTENSIONS_CONFIG || '/app/config/extensions.yml';
const TYPES = ['operator', 'host', 'claude', 'placeholder'];

function exists() {
  return fs.existsSync(CONFIG_PATH);
}

function load() {
  const raw = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  const defaults = raw.defaults || {};
  const hosts = raw.hosts || {};
  const directory = raw.directory || {};
  const devices = {};

  for (const [ext, entry] of Object.entries(raw.extensions || {})) {
    const extension = String(ext);
    const type = entry.type || 'claude';

    if (!TYPES.includes(type)) {
      logger.warn('Unknown extension type, skipping', { extension, type });
      continue;
    }
    if (type === 'host' && !hosts[entry.host]) {
      logger.warn('Extension references unknown host, skipping', { extension, host: entry.host });
      continue;
    }

    devices[extension] = {
      ...entry,
      name: entry.name || extension,
      extension,
      type,
      authId: entry.auth_id || extension,
      password: entry.password,
      voiceId: entry.voice || defaults.voice,
      prompt: entry.prompt,
      sipDomain: defaults.sip_domain,
      hostConfig: type === 'host' ? { id: entry.host, ...hosts[entry.host] } : null
    };
  }

  logger.info('Phone book loaded', {
    path: CONFIG_PATH,
    extensions: Object.keys(devices),
    hosts: Object.keys(hosts)
  });

  return { devices, hosts, directory, defaults };
}

/**
 * Phone book text for the operator prompt: all reachable targets
 * except the operator itself.
 */
function buildDirectoryText(devices, directory, selfExtension) {
  const lines = [];
  for (const device of Object.values(devices)) {
    if (device.extension === selfExtension) continue;
    lines.push('- ' + device.extension + ': ' + device.name +
      (device.description ? ' – ' + device.description : ''));
  }
  for (const [ext, name] of Object.entries(directory)) {
    lines.push('- ' + ext + ': ' + name);
  }
  return lines.join('\n');
}

module.exports = { exists, load, buildDirectoryText, CONFIG_PATH };
