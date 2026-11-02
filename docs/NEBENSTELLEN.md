# Nebenstellen-Setup (docker.mrz.ip + FreePBX)

Kein Install-Skript: alles steht in `docker-compose.yml` (Telefonbuch),
`.env` (Secrets) und `agents/` (Claude-Instanzen).

```
docker-compose.yml   ← Telefonbuch: Nebenstelle → Typ → Ziel; Hosts; Agent-Services
.env                 ← SIP-Passwörter, API-Keys, Claude-Token
agents/<name>/       ← Eigenschaften einer Claude-Instanz (CLAUDE.md, .claude/settings.json)
claude-agent/        ← generisches Image für alle Agents
voice-app/           ← SIP/Audio-Logik
```

## Nebenstellen

| Nr. | Typ | Was passiert |
|---|---|---|
| 999 | `operator` | Vermittlung: Claude (Container `agent-vermittlung`) fragt, wohin, und stellt per SIP-REFER durch |
| 900 | `host` | Prüft `julian-pc`. Wenn Claude dort läuft: direkt verbinden. Wenn aus: „Soll ich ihn starten?" → Wake-on-LAN → wartet → verbindet |
| 901 | `placeholder` | Netzwerk-Agent, sagt erstmal nur „noch nicht eingerichtet" |

### Ablauf 900 (Host)

1. `GET <claude_api>/health`: wenn ok, gleich verbinden.
2. Sonst TCP-Test auf die `probe`-Ports (Standard 22):
   - Rechner an, aber Claude aus: bis `boot_timeout` warten
   - Rechner aus: fragen, ja/nein per Sprache, dann Magic Packet an `wake.mac` über `wake.broadcast`
3. Alle 5 s prüfen, alle 30 s eine Zwischenansage, Wartemusik.
4. Wenn Claude antwortet: Gespräch mit dem claude-api-server auf dem Rechner.

Auf dem Rechner muss der claude-api-server laufen (Port 3333), z.B. per
systemd-User-Unit oder `claude-phone api-server`.

## Weitere Nebenstelle / weiterer Host

```yaml
hosts:
  proxmox:
    name: Proxmox
    address: 192.168.188.10
    claude_api: http://192.168.188.10:3333
    probe: [22, 8006]
    wake: { mac: aa:bb:cc:dd:ee:ff, broadcast: 192.168.188.255 }

extensions:
  "902":
    name: Proxmox
    type: host
    host: proxmox
    password: ${EXT_902_PASSWORD}
    description: Claude auf dem Proxmox-Server
```

Danach `EXT_902_PASSWORD` in `.env` eintragen, die Nebenstelle 902 in FreePBX
anlegen und `docker compose up -d` ausführen. Die Vermittlung kennt die neue
Nebenstelle automatisch, weil das Telefonbuch bei jedem Anruf mitgeschickt wird.

Optionale Felder pro Nebenstelle: `greeting`, `prompt` (zusätzlicher
System-Prompt), `voice` (ElevenLabs-Voice-ID), `timeout` (Sekunden pro
Claude-Antwort), `auth_id` (Standard ist die Nebenstellen-Nummer).

## FreePBX vorbereiten

Für jede Nebenstelle (999, 900, 901) eine **PJSIP-Extension** anlegen:
- Secret wie in `.env`
- Transfers erlaubt (Standard), damit die Vermittlung per REFER durchstellen kann
- Die voice-app registriert sich mit `EXTERNAL_IP:5060`. Auf docker.mrz.ip
  dürfen 5060 (SIP), 5080, 8021, 9022, 3000/3001 und RTP 30000–30100 nicht belegt sein.

## Start

```bash
cp .env.example .env      # ausfüllen
docker compose up -d --build
docker compose logs -f voice-app
```

## Bekannte Einschränkungen

- **Wake-on-LAN** geht nur im selben Netz (192.168.188.0/24) und nur, wenn
  der Rechner WoL kann. `julian-pc` hängt mit `5c:85:7e:3e:f3:1e` am
  USB-Ethernet-Adapter: Bei Laptops klappt WoL meist nur am Dock/Netzteil und
  muss im BIOS aktiviert sein.
- Die Vermittlung startet pro Gesprächsrunde einen Claude-Code-Prozess.
  Mit Haiku dauert eine Antwort ein paar Sekunden.
