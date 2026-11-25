#!/usr/bin/env bash
# ============================================================================
#  check-config.sh – prüft .env + Umgebung für den Claude-Phone-Stack
# ============================================================================
#
#   ./check-config.sh              prüfen; bei Fehlern Dialog zum Beheben anbieten
#   ./check-config.sh --fix        Fehler direkt per Dialog (whiptail) beheben
#   ./check-config.sh --menu       alle Einstellungen im Menü bearbeiten
#   ./check-config.sh --no-online  API-Keys nicht online testen
#   ./check-config.sh --quiet      nur prüfen, nie fragen (Exit-Code 1 bei Fehlern)
#
# Läuft auf docker.mrz.ip im Repo-Ordner, auch per SSH (Dialog im Terminal).
# Secrets werden nie ausgegeben, nur ob sie gesetzt/gültig sind.
set -uo pipefail

cd "$(dirname "$0")"
ENV_FILE=.env
ONLINE=1 MODE=ask
for arg in "$@"; do
  case $arg in
    --fix) MODE=fix ;;
    --menu) MODE=menu ;;
    --quiet) MODE=quiet ;;
    --no-online) ONLINE=0 ;;
    -h|--help) sed -n '5,13p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done

if [[ -t 1 ]]; then
  R=$'\e[31m' G=$'\e[32m' Y=$'\e[33m' B=$'\e[1m' D=$'\e[2m' N=$'\e[0m'
else
  R= G= Y= B= D= N=
fi

# ── Einstellungen: NAME|art|Beschreibung ────────────────────────────────────
#  art: ip, text, secret, opt (optional)
SETTINGS=(
  "EXTERNAL_IP|ip|LAN-IP dieses Docker-Hosts (landet im SDP, sonst kein Audio)"
  "SIP_DOMAIN|text|SIP-Domain der FreePBX, z.B. pbx.mrz.ip"
  "SIP_REGISTRAR|text|IP oder Name der FreePBX, z.B. 192.168.188.42"
  "OPENAI_API_KEY|secret|OpenAI-Key für Whisper (https://platform.openai.com/api-keys)"
  "ELEVENLABS_API_KEY|secret|ElevenLabs-Key für die Sprachausgabe (https://elevenlabs.io/app/settings/api-keys)"
  "ELEVENLABS_VOICE_ID|text|ElevenLabs-Voice-ID"
  "ANTHROPIC_API_KEY|secret|Anthropic-API-Key (https://console.anthropic.com/settings/keys) – ODER Token unten"
  "CLAUDE_CODE_OAUTH_TOKEN|secret|Claude-Abo-Token (claude setup-token) – ODER API-Key oben"
)
# Nebenstellen-Passwörter aus dem Telefonbuch in docker-compose.yml
while read -r v; do
  SETTINGS+=("$v|secret|PJSIP-Secret von Nebenstelle ${v//[!0-9]/} (FreePBX)")
done < <(grep -oE '\$\{EXT_[0-9]+_PASSWORD\}' docker-compose.yml | tr -d '${}' | sort -u)

# ── .env lesen/schreiben (ohne source: Werte können $ enthalten) ────────────
declare -A ENV
load_env() {
  ENV=()
  [[ -f $ENV_FILE ]] || return 0
  local line key val
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]} val=${BASH_REMATCH[2]}
    if [[ $val =~ ^\"(.*)\"[[:space:]]*(#.*)?$ || $val =~ ^\'(.*)\'[[:space:]]*(#.*)?$ ]]; then
      val=${BASH_REMATCH[1]}
    else
      val=$(sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//' <<<"$val")
    fi
    ENV[$key]=$val
  done < "$ENV_FILE"
}

# Wert über die Umgebung übergeben, nicht als Argument (sonst in ps sichtbar)
set_env() {
  KEY=$1 VAL=$2 python3 - "$ENV_FILE" <<'EOF'
import os, re, sys
path, key, val = sys.argv[1], os.environ['KEY'], os.environ['VAL']
lines = open(path).read().splitlines() if os.path.exists(path) else []
pat = re.compile(r'^\s*' + re.escape(key) + r'=')
for i, l in enumerate(lines):
    if pat.match(l):
        lines[i] = f'{key}={val}'
        break
else:
    lines.append(f'{key}={val}')
open(path, 'w').write('\n'.join(lines) + '\n')
os.chmod(path, 0o600)
EOF
}

# ── Ausgabe ─────────────────────────────────────────────────────────────────
ERRORS=() WARNINGS=()
declare -A BAD          # NAME → Grund (für den Dialog)
ok()   { printf '  %s✔%s %s\n' "$G" "$N" "$1"; }
fail() { printf '  %s✘%s %s\n' "$R" "$N" "$1"; ERRORS+=("$1"); [[ -n ${2:-} ]] && BAD[$2]=$1; }
warn() { printf '  %s⚠%s %s\n' "$Y" "$N" "$1"; WARNINGS+=("$1"); }
section() { printf '\n%s%s%s\n' "$B" "$1" "$N"; }

# GET → HTTP_CODE + HTTP_BODY; Header kommen über stdin (-H @-), nicht über argv
http_get() {
  local url=$1 out; shift
  out=$(printf '%s\n' "$@" | curl -s -m 8 -w '\n%{http_code}' -H @- "$url" 2>/dev/null)
  HTTP_CODE=${out##*$'\n'} HTTP_BODY=${out%$'\n'*}
  [[ $HTTP_CODE =~ ^[0-9]{3}$ ]] || HTTP_CODE=000
}

is_ip() { [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }

# ── Prüfungen ───────────────────────────────────────────────────────────────
run_checks() {
  ERRORS=() WARNINGS=() BAD=()
  load_env

  section "Dateien"
  if [[ -f $ENV_FILE ]]; then
    ok ".env vorhanden"
    local perm; perm=$(stat -c %a "$ENV_FILE")
    [[ $perm == 600 ]] && ok ".env nur für dich lesbar (600)" \
      || warn ".env hat Rechte $perm – besser: chmod 600 .env"
  else
    fail ".env fehlt (cp .env.example .env)"
  fi
  if docker compose config -q >/dev/null 2>&1; then
    ok "docker-compose.yml gültig"
  else
    fail "docker compose config meldet Fehler: $(docker compose config -q 2>&1 | head -1)"
  fi

  section "Pflichtwerte"
  local s name kind desc val
  for s in "${SETTINGS[@]}"; do
    IFS='|' read -r name kind desc <<<"$s"
    [[ $name == ANTHROPIC_API_KEY || $name == CLAUDE_CODE_OAUTH_TOKEN ]] && continue
    val=${ENV[$name]:-}
    if [[ -z $val ]]; then
      fail "$name fehlt" "$name"
    elif [[ $kind == ip ]] && ! is_ip "$val"; then
      fail "$name ist keine IPv4-Adresse" "$name"
    else
      ok "$name gesetzt"
    fi
  done

  section "Claude-Zugang"
  local ak=${ENV[ANTHROPIC_API_KEY]:-} tok=${ENV[CLAUDE_CODE_OAUTH_TOKEN]:-}
  if [[ -z $ak && -z $tok ]]; then
    fail "Weder ANTHROPIC_API_KEY noch CLAUDE_CODE_OAUTH_TOKEN gesetzt" ANTHROPIC_API_KEY
  fi
  if [[ -n $ak ]]; then
    if [[ $ak == sk-ant-oat* ]]; then
      fail "ANTHROPIC_API_KEY enthält einen Abo-Token – der gehört nach CLAUDE_CODE_OAUTH_TOKEN" ANTHROPIC_API_KEY
    elif [[ $ak != sk-ant-* ]]; then
      fail "ANTHROPIC_API_KEY sieht falsch aus (erwartet sk-ant-…)" ANTHROPIC_API_KEY
    elif (( ONLINE )); then
      http_get "https://api.anthropic.com/v1/models?limit=100" "x-api-key: $ak" "anthropic-version: 2023-06-01"
      case $HTTP_CODE in
        200)
          ok "ANTHROPIC_API_KEY gültig"
          # Modelle der Agents (CLAUDE_MODEL in docker-compose.yml) verfügbar?
          local models m
          models=$(jq -r '.data[].id' <<<"$HTTP_BODY" 2>/dev/null)
          for m in $(grep -oE '^\s+CLAUDE_MODEL:\s*\S+' docker-compose.yml | awk '{print $2}' | sort -u); do
            grep -qx "$m" <<<"$models" && ok "Modell $m verfügbar" \
              || fail "Modell $m (CLAUDE_MODEL in docker-compose.yml) gibt es für diesen Key nicht"
          done ;;
        401|403) fail "ANTHROPIC_API_KEY wird abgelehnt (ungültig oder gesperrt)" ANTHROPIC_API_KEY ;;
        000) warn "api.anthropic.com nicht erreichbar – Key nicht geprüft" ;;
        *) warn "ANTHROPIC_API_KEY: unerwartete Antwort von api.anthropic.com (HTTP $HTTP_CODE)" ;;
      esac
    else
      ok "ANTHROPIC_API_KEY gesetzt (nicht online geprüft)"
    fi
  fi
  if [[ -n $tok ]]; then
    [[ $tok == sk-ant-oat* ]] && ok "CLAUDE_CODE_OAUTH_TOKEN gesetzt (Format ok, Prüfung erst beim Start)" \
      || fail "CLAUDE_CODE_OAUTH_TOKEN sieht falsch aus (erwartet sk-ant-oat…)" CLAUDE_CODE_OAUTH_TOKEN
  fi

  if (( ONLINE )); then
    section "API-Keys online"
    local k=${ENV[OPENAI_API_KEY]:-}
    if [[ -n $k ]]; then
      http_get https://api.openai.com/v1/models "Authorization: Bearer $k"
      case $HTTP_CODE in
        200) ok "OPENAI_API_KEY gültig" ;;
        401|403) fail "OPENAI_API_KEY wird abgelehnt" OPENAI_API_KEY ;;
        000) warn "api.openai.com nicht erreichbar" ;;
        *) warn "OPENAI_API_KEY: unerwartete Antwort (HTTP $HTTP_CODE)" ;;
      esac
    fi
    # ElevenLabs-Keys können eingeschränkte Rechte haben → über die Stimme prüfen;
    # "missing_permissions" heißt: Key gültig, darf nur das nicht
    k=${ENV[ELEVENLABS_API_KEY]:-}
    local vid=${ENV[ELEVENLABS_VOICE_ID]:-}
    if [[ -n $k && -n $vid ]]; then
      http_get "https://api.elevenlabs.io/v1/voices/$vid" "xi-api-key: $k"
      case $HTTP_CODE in
        200) ok "ELEVENLABS_API_KEY gültig, Stimme $(jq -r '.name // "?"' <<<"$HTTP_BODY" 2>/dev/null | cut -d' ' -f1) gefunden" ;;
        400|404) fail "ELEVENLABS_VOICE_ID unbekannt" ELEVENLABS_VOICE_ID ;;
        401|403)
          if grep -q missing_permissions <<<"$HTTP_BODY"; then
            warn "ELEVENLABS_API_KEY gültig, darf aber keine Stimmen lesen – Stimme nicht geprüft"
          else
            fail "ELEVENLABS_API_KEY wird abgelehnt" ELEVENLABS_API_KEY
          fi ;;
        000) warn "api.elevenlabs.io nicht erreichbar" ;;
        *) warn "ElevenLabs: unerwartete Antwort (HTTP $HTTP_CODE)" ;;
      esac
    fi
  fi

  section "Netzwerk"
  local ext=${ENV[EXTERNAL_IP]:-}
  if [[ -n $ext ]] && is_ip "$ext"; then
    if ip -4 -o addr show | grep -qw "inet $ext"; then
      ok "EXTERNAL_IP $ext gehört zu diesem Host"
    else
      warn "EXTERNAL_IP $ext ist keine IP dieses Hosts ($(hostname)) – läuft das Skript auf dem richtigen Rechner?"
    fi
  fi
  local reg=${ENV[SIP_REGISTRAR]:-}
  if [[ -n $reg ]]; then
    if ping -c1 -W2 "$reg" >/dev/null 2>&1; then
      ok "FreePBX $reg antwortet auf Ping"
    else
      fail "FreePBX $reg antwortet nicht auf Ping" SIP_REGISTRAR
    fi
  fi
  local dom=${ENV[SIP_DOMAIN]:-}
  if [[ -n $dom ]] && ! is_ip "$dom"; then
    getent hosts "$dom" >/dev/null && ok "SIP_DOMAIN $dom löst auf" \
      || warn "SIP_DOMAIN $dom löst nicht auf (egal, solange SIP_REGISTRAR eine IP ist)"
  fi

  section "Ports"
  local running; running=$(docker compose ps -q 2>/dev/null | wc -l)
  if (( running > 0 )); then
    ok "Stack läuft ($running Container) – Port-Prüfung übersprungen"
  else
    local p busy=()
    for p in "${ENV[DRACHTIO_SIP_PORT]:-5060}" 5080 "${ENV[HTTP_PORT]:-3000}" "${ENV[WS_PORT]:-3001}" 9022 8021; do
      ss -Hlntu "sport = :$p" 2>/dev/null | grep -q . && busy+=("$p")
    done
    (( ${#busy[@]} == 0 )) && ok "Ports 5060, 5080, 3000, 3001, 9022, 8021 frei" \
      || fail "Ports belegt: ${busy[*]} (anderer SIP-/Web-Dienst auf diesem Host?)"
  fi

  section "Ergebnis"
  if (( ${#ERRORS[@]} == 0 )); then
    printf '  %s%sAlles in Ordnung%s' "$G" "$B" "$N"
    (( ${#WARNINGS[@]} )) && printf ' %s(%d Hinweise)%s' "$Y" "${#WARNINGS[@]}" "$N"
    printf '\n  Starten mit: %sdocker compose up -d --build%s\n' "$B" "$N"
  else
    printf '  %s%s%d Fehler%s, %d Hinweise\n' "$R" "$B" "${#ERRORS[@]}" "$N" "${#WARNINGS[@]}"
  fi
}

# ── Dialog (whiptail) ───────────────────────────────────────────────────────
have_dialog() { [[ -t 0 && -t 1 ]] && command -v whiptail >/dev/null; }

setting_info() {   # NAME → "art|Beschreibung"
  local s
  for s in "${SETTINGS[@]}"; do
    [[ ${s%%|*} == "$1" ]] && { echo "${s#*|}"; return; }
  done
  echo "text|$1"
}

edit_setting() {
  local name=$1 reason=${2:-} kind desc info new
  info=$(setting_info "$name"); kind=${info%%|*}; desc=${info#*|}
  local text="$desc"
  [[ -n $reason ]] && text+=$'\n\nProblem: '"$reason"
  if [[ $kind == secret ]]; then
    [[ -n ${ENV[$name]:-} ]] && text+=$'\n\n(Aktuell gesetzt – leer lassen = nicht ändern)'
    new=$(whiptail --title "$name" --passwordbox "$text" 16 78 3>&1 1>&2 2>&3) || return 1
  else
    new=$(whiptail --title "$name" --inputbox "$text" 16 78 "${ENV[$name]:-}" 3>&1 1>&2 2>&3) || return 1
  fi
  new=$(sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' <<<"$new")
  [[ -z $new ]] && return 0
  set_env "$name" "$new"
  ENV[$name]=$new
}

ensure_env_file() {
  [[ -f $ENV_FILE ]] && return 0
  whiptail --title ".env fehlt" --yesno ".env aus .env.example anlegen?" 8 60 || exit 1
  cp .env.example "$ENV_FILE" && chmod 600 "$ENV_FILE"
}

fix_dialog() {
  ensure_env_file
  load_env
  local name
  # Claude-Zugang: erst fragen, welche Variante
  if [[ -n ${BAD[ANTHROPIC_API_KEY]:-} && -z ${ENV[ANTHROPIC_API_KEY]:-}${ENV[CLAUDE_CODE_OAUTH_TOKEN]:-} ]]; then
    local choice
    choice=$(whiptail --title "Claude-Zugang" --menu "Wie soll der Agent auf Claude zugreifen?" 14 78 2 \
      ANTHROPIC_API_KEY "API-Key (console.anthropic.com, Abrechnung pro Nutzung)" \
      CLAUDE_CODE_OAUTH_TOKEN "Abo-Token (claude setup-token)" 3>&1 1>&2 2>&3) || return
    unset 'BAD[ANTHROPIC_API_KEY]'
    edit_setting "$choice" "Kein Claude-Zugang gesetzt"
  fi
  for name in "${!BAD[@]}"; do
    edit_setting "$name" "${BAD[$name]}" || break
  done
}

menu_dialog() {
  ensure_env_file
  while true; do
    load_env
    local items=() s name kind desc state choice
    for s in "${SETTINGS[@]}"; do
      IFS='|' read -r name kind desc <<<"$s"
      if [[ -z ${ENV[$name]:-} ]]; then state="– leer –"
      elif [[ $kind == secret ]]; then state="gesetzt"
      else state=${ENV[$name]}
      fi
      items+=("$name" "$state")
    done
    choice=$(whiptail --title "Claude Phone – Einstellungen" --ok-button "Bearbeiten" --cancel-button "Fertig" \
      --menu "Einstellung wählen (.env in $(pwd))" 22 78 14 "${items[@]}" 3>&1 1>&2 2>&3) || break
    edit_setting "$choice"
  done
}

# ── Ablauf ──────────────────────────────────────────────────────────────────
if [[ $MODE == menu ]]; then
  have_dialog || { echo "Menü braucht ein Terminal und whiptail" >&2; exit 2; }
  menu_dialog
  clear
fi

run_checks
(( ${#ERRORS[@]} == 0 )) && exit 0
[[ $MODE == quiet ]] && exit 1

if ! have_dialog; then
  echo; echo "Zum Beheben: ./check-config.sh --fix  (oder .env von Hand bearbeiten)"
  exit 1
fi
if [[ $MODE == ask ]]; then
  if (( ${#BAD[@]} == 0 )); then
    echo; echo "Diese Fehler lassen sich nicht über die .env beheben."
    exit 1
  fi
  printf '\nFehler jetzt im Dialog beheben? [J/n] '
  read -r answer
  [[ -z $answer || $answer =~ ^[JjYy] ]] || exit 1
fi
if (( ${#BAD[@]} )); then
  fix_dialog
  clear
  echo "${B}Erneute Prüfung:${N}"
  run_checks
fi
(( ${#ERRORS[@]} == 0 ))
