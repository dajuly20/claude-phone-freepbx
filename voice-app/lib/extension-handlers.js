/**
 * Extension Handlers
 * One call flow per extension type (see extension-config.js).
 */

const axios = require('axios');
const hostControl = require('./host-control');
const pbxDirectory = require('./pbx-directory');
const recentTargets = require('./recent-targets');
const { parseYesNo, sleep } = require('./call-session');

const TRANSFER_RE = /🔀\s*TRANSFER:\s*\*?\*?\s*([0-9*#+]+)/i;
const OPERATOR_SILENCE_MS = 5000; // caller silent after greeting → read recent targets
const HOST_POLL_MS = 5000;
const HOST_STATUS_EVERY_MS = 30000;

function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

// What the caller hears when an agent's /health is not ok
const AGENT_DOWN_TEXT = {
  missing: 'ist gerade nicht verfügbar: Für Claude ist kein Zugang eingerichtet.',
  invalid: 'ist gerade nicht verfügbar: Der Claude-Zugang wird abgelehnt. Bitte den API-Key prüfen.',
  unreachable: 'ist gerade nicht verfügbar: Anthropic ist nicht erreichbar.',
  down: 'ist gerade nicht verfügbar: Der Claude-Container antwortet nicht.'
};

/**
 * Check an agent before greeting the caller, so a broken Claude access
 * gives a clear announcement instead of silence or a generic error.
 * @returns {Promise<boolean>} true if the agent is usable
 */
async function agentReady(call, device) {
  let state;
  try {
    await axios.get(device.agent + '/health', { timeout: 10000 });
    return true;
  } catch (err) {
    state = (err.response && err.response.data && err.response.data.claude_auth) || 'down';
    log('AGENT ' + device.agent + ' not ready: ' + state +
      (err.response && err.response.data ? ' – ' + err.response.data.detail : ' – ' + err.message));
  }
  await call.say(device.name + ' ' + (AGENT_DOWN_TEXT[state] || AGENT_DOWN_TEXT.down));
  return false;
}

/** type: claude – plain conversation with one agent */
async function handleClaude(call, device) {
  if (!(await agentReady(call, device))) return;
  const callerLine = call.callerId ? '[ANRUFER] Nebenstelle ' + call.callerId : '[ANRUFER] unbekannt';
  await call.converse(device.agent, {
    greeting: device.greeting || 'Hallo! Hier ist ' + device.name + '. Wie kann ich dir helfen?',
    devicePrompt: [device.prompt || '', callerLine].join('\n'),
    timeout: device.timeout || 60
  });
}

/** type: placeholder – say message, hang up */
async function handlePlaceholder(call, device) {
  await call.say(device.message || device.name + ' ist noch nicht eingerichtet.');
}

/**
 * "Zuletzt gewählt: …" – the caller's last targets, topped up with own
 * agents and people from the PBX book so there is always something to say.
 */
function recentTargetsText(callerId, pbx, devices, selfExtension) {
  const names = {};
  for (const d of Object.values(devices || {})) names[String(d.extension)] = d.name;
  if (pbx) for (const z of pbx.ziele) names[z.nummer] = z.name; // PBX names win
  const fillers = Object.values(devices || {}).filter(d => d.type !== 'placeholder')
    .map(d => String(d.extension))
    .concat(pbx ? pbx.ziele.filter(z => z.art === 'person').map(z => z.nummer) : [])
    .filter(n => n !== String(selfExtension));
  const list = recentTargets.recent(callerId, 5, fillers)
    .filter(n => n !== String(selfExtension) && names[n]);
  if (!list.length) return '';
  return 'Zuletzt gewählt: ' + list.map(n => names[n]).join(', ') + '.';
}

// Main menu of the PBX ("1"): keys pressed during the operator call are put
// straight through. Override per extension with dtmf_map / menu_text in extensions.yml.
const OPERATOR_DTMF_MAP = { 1: '1', 2: '20', 3: '30', 5: '50', 6: '60', 7: '7', 9: '9' };
const OPERATOR_MENU_TEXT = 'Hauptmenü: Personen die 2, St. Georgen die 3, Durchsage die 5, ' +
  'Mailbox die 6, Home Assistant die 7, Konferenzraum die 9 – oder sag mir einfach, ' +
  'wen du sprechen möchtest.';
const HAUPTMENUE_RE = /^\W*(?:(?:ins|zum|das|ich will ins|bitte)\s+)*haupt\s*men[üu]e?\W*(?:bitte)?\W*$/i;

/** type: operator – Claude decides whom to connect, we REFER */
async function handleOperator(call, device, ctx) {
  if (!(await agentReady(call, device))) return;

  const pbx = await pbxDirectory.fetchDirectory();
  const directory = pbxDirectory.buildText(
    pbx, ctx.deviceRegistry.getAll(), ctx.deviceRegistry.getDirectory(), device.extension);

  const devicePrompt = [
    device.prompt || '',
    '[TELEFONBUCH]',
    directory,
    '[END TELEFONBUCH]',
    'Zum Durchstellen schreibe eine eigene Zeile "🔀 TRANSFER: <nummer>" zusätzlich zur VOICE_RESPONSE.'
  ].join('\n');

  let transferring = false;
  async function transferTo(target, why, remember) {
    if (transferring) return false;
    transferring = true;
    call.handedOff = true; // the conversation loop stops talking from here on
    log('OPERATOR transfer -> ' + target + ' (' + why + ')');
    try {
      await call.transfer(target);
      if (remember) recentTargets.record(call.callerId, target);
      return true;
    } catch (err) {
      log('TRANSFER failed: ' + err.message);
      transferring = false;
      call.handedOff = false;
      await call.say('Das Durchstellen hat leider nicht geklappt.');
      return false;
    }
  }

  // Keys of the main menu work at any time during the call
  const dtmfMap = device.dtmf_map || OPERATOR_DTMF_MAP;
  call.enableDtmf(async function(digit) {
    const target = dtmfMap[digit];
    if (!target || transferring) return;
    await call.breakPlayback();
    await transferTo(String(target), 'Taste ' + digit, false);
  });

  await call.converse(device.agent, {
    greeting: device.greeting || 'Vermittlung, guten Tag. Mit wem darf ich dich verbinden?',
    devicePrompt: devicePrompt,
    timeout: device.timeout || 30,
    firstSilenceMs: device.silence_hint_ms === undefined ? OPERATOR_SILENCE_MS : device.silence_hint_ms,
    onFirstSilence: async function() {
      const recent = recentTargetsText(call.callerId, pbx, ctx.deviceRegistry.getAll(), device.extension);
      const text = [recent, device.menu_text || OPERATOR_MENU_TEXT].filter(Boolean).join(' ');
      log('OPERATOR silent caller – ' + text);
      await call.say(text);
    },
    beforeAsk: async function(transcript) {
      if (!HAUPTMENUE_RE.test(transcript)) return 'continue';
      await call.say('Ich verbinde mit dem Hauptmenü.');
      return (await transferTo('1', 'gesagt: ' + transcript, false)) ? 'stop' : 'continue';
    },
    onResponse: async function(response) {
      const match = response.match(TRANSFER_RE);
      if (!match) return 'continue';
      return (await transferTo(match[1], 'Claude', true)) ? 'stop' : 'continue';
    }
  });
}

/**
 * Poll until the host's claude-api-server answers.
 */
async function waitForHost(call, host) {
  // @returns {Promise<string|null>} claude-api-server URL once ready
  const deadline = Date.now() + (host.boot_timeout || 180) * 1000;
  let lastStatus = Date.now();

  call.startHoldMusic();
  while (Date.now() < deadline && call.active) {
    await sleep(HOST_POLL_MS);
    const { state, apiUrl } = await hostControl.checkHost(host);
    log('HOST ' + host.id + ' state: ' + state);
    if (state === 'ready') {
      await call.stopHoldMusic();
      return apiUrl;
    }
    if (Date.now() - lastStatus > HOST_STATUS_EVERY_MS) {
      lastStatus = Date.now();
      await call.stopHoldMusic();
      await call.say(state === 'up-no-claude'
        ? 'Der Rechner ist hochgefahren, Claude startet noch.'
        : 'Der Rechner fährt noch hoch, einen Moment bitte.');
      call.startHoldMusic();
    }
  }
  await call.stopHoldMusic();
  return null;
}

/** type: host – check, optionally wake, then talk to the host's Claude */
async function handleHost(call, device) {
  const host = device.hostConfig;
  const hostName = host.name || host.id;

  let { state, apiUrl } = await hostControl.checkHost(host);
  log('HOST ' + host.id + ' initial state: ' + state + (apiUrl ? ' (' + apiUrl + ')' : ''));

  if (state === 'up-no-claude') {
    await call.say(hostName + ' ist an, aber Claude antwortet dort gerade nicht. Ich warte kurz.');
    apiUrl = await waitForHost(call, host);
    if (!apiUrl) {
      await call.say('Claude ist auf ' + hostName + ' leider nicht erreichbar. Bitte prüfe den claude-api-server.');
      return;
    }
  } else if (state === 'down') {
    if (!host.wake) {
      await call.say(hostName + ' ist gerade nicht erreichbar.');
      return;
    }

    await call.say(hostName + ' ist aus. Soll ich ihn starten?');
    let answer = null;
    for (let i = 0; i < 2 && answer === null && call.active; i++) {
      const transcript = await call.listen({ timeoutMs: 10000 });
      answer = transcript ? parseYesNo(transcript) : null;
      if (answer === null && i === 0) await call.say('Bitte sag ja oder nein.');
    }
    if (!answer) {
      await call.say('Alles klar, dann nicht. Auf Wiederhören!');
      return;
    }

    try {
      await hostControl.wakeHost(host);
    } catch (err) {
      log('WAKE failed: ' + err.message);
      await call.say('Das Wecksignal konnte nicht gesendet werden.');
      return;
    }
    await call.say('Ich starte ' + hostName + '. Das dauert etwa eine Minute, bleib dran.');

    apiUrl = await waitForHost(call, host);
    if (!apiUrl) {
      await call.say(hostName + ' ist nicht rechtzeitig hochgekommen. Versuch es gleich nochmal.');
      return;
    }
    await call.say(hostName + ' ist jetzt bereit.');
  }

  await call.converse(apiUrl, {
    greeting: device.greeting || 'Hier ist Claude auf ' + hostName + '. Was kann ich tun?',
    devicePrompt: device.prompt,
    timeout: device.timeout || 120
  });
}

const HANDLERS = {
  claude: handleClaude,
  operator: handleOperator,
  host: handleHost,
  placeholder: handlePlaceholder
};

async function runExtension(call, device, ctx) {
  const handler = HANDLERS[device.type] || handleClaude;
  log('CALL Handler: ' + (device.type || 'claude') + ' for ' + device.name + ' (ext ' + device.extension + ')');
  await handler(call, device, ctx);
}

module.exports = { runExtension, TRANSFER_RE };
