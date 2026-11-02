/**
 * Extension Handlers
 * One call flow per extension type (see extension-config.js).
 */

const hostControl = require('./host-control');
const extensionConfig = require('./extension-config');
const { parseYesNo, sleep } = require('./call-session');

const TRANSFER_RE = /🔀\s*TRANSFER:\s*\*?\*?\s*([0-9*#+]+)/i;
const HOST_POLL_MS = 5000;
const HOST_STATUS_EVERY_MS = 30000;

function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

/** type: claude – plain conversation with one agent */
async function handleClaude(call, device) {
  await call.converse(device.agent, {
    greeting: device.greeting || 'Hallo! Hier ist ' + device.name + '. Wie kann ich dir helfen?',
    devicePrompt: device.prompt,
    timeout: device.timeout || 60
  });
}

/** type: placeholder – say message, hang up */
async function handlePlaceholder(call, device) {
  await call.say(device.message || device.name + ' ist noch nicht eingerichtet.');
}

/** type: operator – Claude decides whom to connect, we REFER */
async function handleOperator(call, device, ctx) {
  const directory = extensionConfig.buildDirectoryText(
    ctx.deviceRegistry.getAll(), ctx.deviceRegistry.getDirectory(), device.extension);

  const devicePrompt = [
    device.prompt || '',
    '[TELEFONBUCH]',
    directory,
    '[END TELEFONBUCH]',
    'Zum Durchstellen schreibe eine eigene Zeile "🔀 TRANSFER: <nummer>" zusätzlich zur VOICE_RESPONSE.'
  ].join('\n');

  await call.converse(device.agent, {
    greeting: device.greeting || 'Vermittlung, guten Tag. Mit wem darf ich dich verbinden?',
    devicePrompt: devicePrompt,
    timeout: device.timeout || 30,
    onResponse: async function(response) {
      const match = response.match(TRANSFER_RE);
      if (!match) return 'continue';
      try {
        await call.transfer(match[1]);
      } catch (err) {
        log('TRANSFER failed: ' + err.message);
        await call.say('Das Durchstellen hat leider nicht geklappt.');
        return 'continue';
      }
      return 'stop';
    }
  });
}

/**
 * Poll until the host's claude-api-server answers.
 * @returns {Promise<boolean>} true when ready
 */
async function waitForHost(call, host) {
  const deadline = Date.now() + (host.boot_timeout || 180) * 1000;
  let lastStatus = Date.now();

  call.startHoldMusic();
  while (Date.now() < deadline && call.active) {
    await sleep(HOST_POLL_MS);
    const state = await hostControl.checkHost(host);
    log('HOST ' + host.id + ' state: ' + state);
    if (state === 'ready') {
      await call.stopHoldMusic();
      return true;
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
  return false;
}

/** type: host – check, optionally wake, then talk to the host's Claude */
async function handleHost(call, device) {
  const host = device.hostConfig;
  const hostName = host.name || host.id;

  const state = await hostControl.checkHost(host);
  log('HOST ' + host.id + ' initial state: ' + state);

  if (state === 'up-no-claude') {
    await call.say(hostName + ' ist an, aber Claude antwortet dort gerade nicht. Ich warte kurz.');
    if (!(await waitForHost(call, host))) {
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

    if (!(await waitForHost(call, host))) {
      await call.say(hostName + ' ist nicht rechtzeitig hochgekommen. Versuch es gleich nochmal.');
      return;
    }
    await call.say(hostName + ' ist jetzt bereit.');
  }

  await call.converse(host.claude_api, {
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
