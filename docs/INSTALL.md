# Docker Installation Guide

Detailed walkthrough of the Docker-based setup for Claude Phone: what each
container does, how the two networking modes differ, and how to configure
`.env` correctly the first time so audio actually works.

If you just want the fast path, use `install.sh` + `claude-phone setup` as
described in the [README](../README.md). This guide is for when you want to
understand (or hand-configure) what that wizard does under the hood, or when
you're troubleshooting a Docker-specific problem.

## What gets deployed

`docker-compose.yml` defines three containers:

| Container    | Image                                    | Role                                      |
|--------------|-------------------------------------------|--------------------------------------------|
| `drachtio`   | `drachtio/drachtio-server:latest`         | SIP signaling — registers with 3CX, handles INVITE/BYE etc. |
| `freeswitch` | `drachtio/drachtio-freeswitch-mrf:latest` | Media server — plays/records RTP audio, bridges to Whisper/ElevenLabs |
| `voice-app`  | Built locally from `./voice-app`          | Node.js app — conversation logic, HTTP API, WebSocket audio streaming |

`voice-app` depends on the other two and talks to them over `localhost`
(hence the networking requirement below). It in turn calls out to your
`claude-api-server` over HTTP — that piece is **not** in this compose file
and typically runs on a separate machine with Claude Code CLI installed (see
"Split Deployment" in the [README](../README.md)).

## Prerequisites

- Docker Engine + Docker Compose plugin (`docker compose version` should work)
- A `.env` file (copy from `.env.example`)
- A 3CX extension already created and its SBC/registrar reachable from this host
- ElevenLabs and OpenAI API keys
- If running split-mode: a `claude-api-server` reachable over the network

Install Docker if you don't have it:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# log out/in, or: newgrp docker
```

## Step 1 — Clone and configure

```bash
git clone https://github.com/theNetworkChuck/claude-phone.git
cd claude-phone
cp .env.example .env
```

Edit `.env`. The variables that actually matter for the Docker containers
(as opposed to the voice-app's own logic) are:

```bash
EXTERNAL_IP=10.0.0.100        # see "Networking mode" below — critical
DRACHTIO_SECRET=cymru         # shared secret between drachtio and voice-app
DRACHTIO_SIP_PORT=5060        # 5060 for direct registration, 5070 if a 3CX SBC also wants 5060
FREESWITCH_SECRET=JambonzR0ck$ # ESL secret between freeswitch and voice-app
```

Everything else in `.env` (SIP credentials, API keys, ports) is consumed by
`voice-app` at runtime — see `.env.example` for the full list with comments.

### The one setting that breaks audio if wrong: `EXTERNAL_IP`

`EXTERNAL_IP` is embedded into SDP (the audio negotiation payload) so 3CX
knows where to send RTP packets. It must be **this machine's LAN IP**, not
`127.0.0.1`, not a Docker-internal IP, and not a hostname.

```bash
# Linux
hostname -I | awk '{print $1}'
# or
ip route get 1 | awk '{print $7; exit}'

# macOS
ipconfig getifaddr en0
```

`start.sh` auto-detects this for you if `EXTERNAL_IP` isn't already
customized in `.env` — see Step 3.

## Step 2 — Choose a networking mode

This is the part most worth understanding before you run anything.

### Host networking (default, Linux)

`docker-compose.yml` sets `network_mode: host` on all three services. This
means the containers share the host's network stack directly — no port
mapping needed, no NAT translation inside Docker.

**Why this matters:** Docker's default bridge networking assigns containers
internal IPs (e.g. `172.17.0.2`). If FreeSWITCH advertised that IP in SDP,
3CX would try to send audio to an address it can't reach, and calls would
connect with no audio in either direction. Host mode avoids this entirely by
letting FreeSWITCH bind directly to the host's real interfaces.

This is why `EXTERNAL_IP` still has to be set explicitly even in host mode —
host mode fixes *routability*, but FreeSWITCH still needs to be told which
of the host's IPs to advertise.

Host mode works out of the box on Linux (including Raspberry Pi). **It does
not work correctly on Docker Desktop for Mac**, because Docker Desktop runs
containers inside a hidden Linux VM — `network_mode: host` there means "host
of the VM," not your Mac.

### Bridge networking (Mac / Docker Desktop)

Use the override file:

```bash
docker compose -f docker-compose.yml -f docker-compose.bridge.yml up -d
```

Or set it once in `.env` so plain `docker compose up -d` picks it up
automatically:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.bridge.yml
```

`docker-compose.bridge.yml` switches all three services to
`network_mode: bridge` and explicitly maps the ports each one needs:

| Port(s)          | Protocol | Service    |
|------------------|----------|------------|
| 5060             | UDP/TCP  | drachtio (SIP) |
| 9022             | TCP      | drachtio (admin) |
| 5080             | UDP      | freeswitch (internal SIP) |
| 8021             | TCP      | freeswitch (ESL) |
| 20000–20100      | UDP      | freeswitch (RTP audio) |
| 3000, 3001       | TCP      | voice-app (HTTP + WebSocket) |

You **still must set `EXTERNAL_IP`** to your Mac's real LAN IP even in
bridge mode — mapping ports doesn't change what IP gets written into SDP.

Don't widen the RTP range past 100 ports — Docker Desktop's port-forwarding
proxies one process per mapped port, so a much larger range noticeably slows
container startup and eats resources. 100 ports supports roughly 50
concurrent calls (2 ports/call), which is generous for a home setup.

## Step 3 — Start the containers

Easiest path — `start.sh` detects your OS, auto-fills `EXTERNAL_IP` if you
haven't customized it, and picks the right compose invocation:

```bash
./start.sh
```

Manually:

```bash
# Linux (host networking)
docker compose up -d

# Mac (bridge networking)
docker compose -f docker-compose.yml -f docker-compose.bridge.yml up -d
```

Check everything came up:

```bash
docker compose ps
docker compose logs -f
```

A healthy startup shows drachtio registering with 3CX and voice-app
listening on port 3000:

```
[SIP] Connected to drachtio
[SIP] Registered extension 9000 with 3CX
[HTTP] Server listening on port 3000
```

## Step 4 — Firewall rules (if applicable)

If this host has a firewall (ufw, firewalld, cloud security group), open:

```bash
sudo ufw allow 5060/udp
sudo ufw allow 5060/tcp
sudo ufw allow 30000:30100/udp   # or 20000:20100 in bridge mode
sudo ufw allow 3000/tcp          # only if voice-app's API needs to be reached externally
```

## Verifying it actually works

1. `docker compose ps` — all three containers `Up`, none restarting in a loop.
2. `docker compose logs voice-app | grep -i registered` — confirms SIP registration succeeded.
3. Call the extension from a real phone. If it rings but there's no audio
   either direction, it's almost always `EXTERNAL_IP` — re-check it matches
   this host's actual LAN IP and re-run `docker compose up -d` (drachtio and
   freeswitch need to restart to pick up a changed `.env`).
4. `curl http://<host-ip>:3000/api/devices` — confirms the HTTP API is reachable.

## Updating

```bash
git pull
docker compose build voice-app   # only voice-app is built locally; drachtio/freeswitch are pulled images
docker compose up -d
```

To pick up new upstream drachtio/freeswitch images:

```bash
docker compose pull
docker compose up -d
```

## Stopping / removing

```bash
docker compose down            # stop and remove containers, keep volumes/config
docker compose down -v         # also remove named volumes (audio files config bind-mounts are unaffected)
```

## Common Docker-specific problems

| Symptom | Cause | Fix |
|---|---|---|
| Calls connect, no audio | `EXTERNAL_IP` wrong or unset | Re-check with `hostname -I` / `ipconfig getifaddr en0`, update `.env`, `docker compose up -d` |
| Works on Linux, silent on Mac | Using host networking on Docker Desktop | Switch to `docker-compose.bridge.yml` |
| `bind: address already in use` on port 5060 | 3CX's own SBC is running on this host | Set `DRACHTIO_SIP_PORT=5070` in `.env` and update drachtio's `--contact` port accordingly |
| voice-app can't reach freeswitch/drachtio | Mixed networking modes (e.g. one service overridden, others not) | Ensure all three services use the same `network_mode` — don't mix host and bridge |
| RTP audio choppy or one-directional under load | Too many concurrent calls for the mapped RTP range in bridge mode | Bridge mode maxes out around ~50 concurrent calls (100 ports); use host networking (Linux) for more |
| `.env` changes don't take effect | drachtio/freeswitch read CLI flags at container start, not live | `docker compose up -d` again — compose recreates containers when the effective config changed |

For non-Docker issues (3CX config, STT/TTS, device personalities) see the
main [Troubleshooting Guide](TROUBLESHOOTING.md).
