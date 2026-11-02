/**
 * Host Control
 * Reachability checks and Wake-on-LAN for "host" extensions.
 */

const dgram = require('dgram');
const net = require('net');
const axios = require('axios');

/**
 * TCP connect test (no ping: containers lack NET_RAW by default)
 */
function tcpProbe(address, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function claudeApiUp(host) {
  if (!host.claude_api) return false;
  try {
    await axios.get(host.claude_api + '/health', { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<'ready'|'up-no-claude'|'down'>}
 */
async function checkHost(host) {
  if (await claudeApiUp(host)) return 'ready';
  const ports = host.probe || [22];
  const results = await Promise.all(ports.map((p) => tcpProbe(host.address, p)));
  return results.some(Boolean) ? 'up-no-claude' : 'down';
}

function sendMagicPacket(mac, broadcast = '255.255.255.255', port = 9) {
  const macBytes = Buffer.from(mac.replace(/[^0-9a-f]/gi, ''), 'hex');
  if (macBytes.length !== 6) {
    return Promise.reject(new Error('Invalid MAC address: ' + mac));
  }
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => { socket.close(); reject(err); });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, port, broadcast, (err) => {
        socket.close();
        if (err) reject(err); else resolve();
      });
    });
  });
}

async function wakeHost(host) {
  if (!host.wake || !host.wake.mac) throw new Error('No wake config for host');
  // Send a few packets; WoL is fire-and-forget UDP
  for (let i = 0; i < 3; i++) {
    await sendMagicPacket(host.wake.mac, host.wake.broadcast, host.wake.port || 9);
  }
}

module.exports = { checkHost, claudeApiUp, wakeHost, sendMagicPacket, tcpProbe };
