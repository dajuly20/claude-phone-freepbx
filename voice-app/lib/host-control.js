/**
 * Host Control
 * Reachability checks and Wake-on-LAN for "host" extensions.
 */

const dgram = require('dgram');
const dns = require('dns').promises;
const net = require('net');
const axios = require('axios');

/**
 * All IPs a host may currently have. Laptops change interface (LAN, WLAN,
 * WireGuard) and DHCP lease, so a host lists several addresses/hostnames and
 * each hostname is resolved to all of its A records.
 * Legacy: single "address" + "claude_api" URL.
 */
async function candidateAddresses(host) {
  const entries = [].concat(host.addresses || host.address || []);
  const result = [];
  for (const entry of entries) {
    if (net.isIP(entry)) {
      result.push(entry);
      continue;
    }
    try {
      const records = await dns.lookup(entry, { all: true, family: 4 });
      for (const r of records) result.push(r.address);
    } catch {
      // name currently not resolvable (e.g. laptop away from home)
    }
  }
  return [...new Set(result)];
}

function apiUrlFor(host, address) {
  return 'http://' + address + ':' + (host.claude_port || 3333);
}

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

async function healthy(apiUrl) {
  try {
    await axios.get(apiUrl + '/health', { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * First claude-api-server URL of this host that answers, or null.
 */
async function findClaudeApi(host) {
  const urls = host.claude_api && !host.addresses
    ? [host.claude_api]
    : (await candidateAddresses(host)).map((a) => apiUrlFor(host, a));
  const results = await Promise.all(urls.map(async (u) => ((await healthy(u)) ? u : null)));
  return results.find(Boolean) || null;
}

/**
 * @returns {Promise<{state: 'ready'|'up-no-claude'|'down', apiUrl: string|null}>}
 */
async function checkHost(host) {
  const apiUrl = await findClaudeApi(host);
  if (apiUrl) return { state: 'ready', apiUrl };

  const addresses = await candidateAddresses(host);
  const ports = host.probe || [22];
  const probes = [];
  for (const a of addresses) for (const p of ports) probes.push(tcpProbe(a, p));
  const results = await Promise.all(probes);
  return { state: results.some(Boolean) ? 'up-no-claude' : 'down', apiUrl: null };
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
  const macs = [].concat((host.wake && (host.wake.macs || host.wake.mac)) || []);
  if (macs.length === 0) throw new Error('No wake config for host');
  // Every NIC that might be plugged in; WoL is fire-and-forget UDP
  for (let i = 0; i < 3; i++) {
    for (const mac of macs) {
      await sendMagicPacket(mac, host.wake.broadcast, host.wake.port || 9);
    }
  }
}

module.exports = { checkHost, findClaudeApi, candidateAddresses, wakeHost, sendMagicPacket, tcpProbe };
