#!/bin/bash
set -e

# ============================================================================
# Claude Phone - "Call" Skill Installer
# ============================================================================
# Automates the setup described in docs/CLAUDE-CODE-SKILL.md: creates
# ~/.claude/skills/Call with SKILL.md, bin/call, lib/api.py, and
# workflows/MakeCall.md, pre-filled with this deployment's server URL and
# devices (auto-detected from .env / voice-app/config/devices.json when run
# from this repo).
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SKILL_DIR="${CLAUDE_SKILL_DIR:-$HOME/.claude/skills/Call}"
API_URL=""
EXTENSION=""
FORCE=0
UNINSTALL=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Installs the Claude Phone "Call" skill to ~/.claude/skills/Call so your
Claude Code sessions can place outbound calls via the "call" CLI.

Options:
  --api-url URL       Voice API base URL (e.g. http://192.168.1.50:3000)
                       Auto-detected from .env (EXTERNAL_IP + HTTP_PORT) if omitted.
  --extension NUM      Default extension for "me"/"myself" contact.
                       Auto-detected from voice-app/config/devices.json if omitted.
  --skill-dir PATH     Install location (default: ~/.claude/skills/Call)
  --force              Overwrite an existing installation without prompting
  --uninstall          Remove the skill from --skill-dir instead of installing
  -h, --help           Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url) API_URL="$2"; shift 2 ;;
    --extension) EXTENSION="$2"; shift 2 ;;
    --skill-dir) SKILL_DIR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# ----------------------------------------------------------------------------
# Uninstall
# ----------------------------------------------------------------------------
if [[ $UNINSTALL -eq 1 ]]; then
  if [[ ! -d "$SKILL_DIR" ]]; then
    echo "Nothing to uninstall - $SKILL_DIR does not exist."
    exit 0
  fi
  if [[ $FORCE -ne 1 ]]; then
    read -p "Remove the Call skill at $SKILL_DIR? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "Aborted."
      exit 1
    fi
  fi
  rm -rf "$SKILL_DIR"
  echo "✓ Removed $SKILL_DIR"
  exit 0
fi

if ! command -v python3 &> /dev/null; then
  echo "✗ python3 is required (the skill's CLI is a Python script) but was not found."
  exit 1
fi

# ----------------------------------------------------------------------------
# Auto-detect API URL from .env
# ----------------------------------------------------------------------------
if [[ -z "$API_URL" && -f "$SCRIPT_DIR/.env" ]]; then
  EXTERNAL_IP=$(grep -E '^EXTERNAL_IP=' "$SCRIPT_DIR/.env" | head -1 | cut -d= -f2-)
  HTTP_PORT=$(grep -E '^HTTP_PORT=' "$SCRIPT_DIR/.env" | head -1 | cut -d= -f2-)
  HTTP_PORT="${HTTP_PORT:-3000}"
  if [[ -n "$EXTERNAL_IP" ]]; then
    API_URL="http://${EXTERNAL_IP}:${HTTP_PORT}"
    echo "✓ Detected API URL from .env: $API_URL"
  fi
fi
API_URL="${API_URL:-http://YOUR_SERVER:3000}"

# ----------------------------------------------------------------------------
# Default extension for the "me"/"myself" contact
# ----------------------------------------------------------------------------
# NOT auto-detected from devices.json: that file lists the AI's own inbound
# extensions (e.g. Morpheus on 900), which is the wrong thing to dial when the
# user says "call me" - "me" must be YOUR phone (softphone, desk extension,
# Fritz!Fon, ...), so it has to be passed explicitly via --extension.
DEVICES_JSON="$SCRIPT_DIR/voice-app/config/devices.json"
if [[ -z "$EXTENSION" ]]; then
  EXTENSION="YOUR_EXTENSION"
fi

# ----------------------------------------------------------------------------
# Fingerprint this configuration so re-running with unchanged settings is a
# no-op instead of prompting/overwriting every time.
# ----------------------------------------------------------------------------
FINGERPRINT_INPUT="$API_URL|$EXTENSION"
if [[ -f "$DEVICES_JSON" ]]; then
  FINGERPRINT_INPUT="$FINGERPRINT_INPUT|$(sha256sum "$DEVICES_JSON" | cut -d' ' -f1)"
fi
FINGERPRINT=$(printf '%s' "$FINGERPRINT_INPUT" | sha256sum | cut -d' ' -f1)
META_FILE="$SKILL_DIR/.install-meta"

# ----------------------------------------------------------------------------
# Confirm overwrite
# ----------------------------------------------------------------------------
if [[ -d "$SKILL_DIR" && $FORCE -ne 1 ]]; then
  if [[ -f "$META_FILE" && "$(cat "$META_FILE")" == "$FINGERPRINT" ]]; then
    echo "✓ Already installed at $SKILL_DIR with identical configuration - nothing to do."
    echo "  Use --force to reinstall anyway, or --uninstall to remove it."
    exit 0
  fi
  read -p "Skill already exists at $SKILL_DIR. Overwrite? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
  fi
fi

mkdir -p "$SKILL_DIR/bin" "$SKILL_DIR/lib" "$SKILL_DIR/workflows"

# ----------------------------------------------------------------------------
# Generate all skill files (Python does the templating - safer than bash
# heredoc escaping for content full of quotes, braces, and dollar signs)
# ----------------------------------------------------------------------------
SKILL_DIR="$SKILL_DIR" API_URL="$API_URL" EXTENSION="$EXTENSION" DEVICES_JSON="$DEVICES_JSON" \
python3 <<'PYEOF'
import json
import os

skill_dir = os.environ['SKILL_DIR']
api_url = os.environ['API_URL']
default_extension = os.environ['EXTENSION']
devices_json_path = os.environ['DEVICES_JSON']

# Build device list: prefer real devices.json, fall back to doc's example
devices = []
if os.path.isfile(devices_json_path):
    with open(devices_json_path) as f:
        raw = json.load(f)
    for ext, cfg in raw.items():
        devices.append({
            'key': cfg['name'].lower(),
            'name': cfg['name'],
            'extension': cfg.get('extension', ext),
            'description': 'AI assistant (see devices.json for personality prompt)',
        })
else:
    devices = [{
        'key': 'morpheus',
        'name': 'Morpheus',
        'extension': default_extension,
        'description': 'Principal AI assistant',
    }]

default_device_name = devices[0]['name']

devices_dict_src = ',\n'.join(
    f'    {d["key"]!r}: {{\n'
    f'        "name": {d["name"]!r},\n'
    f'        "extension": {d["extension"]!r},\n'
    f'        "description": {d["description"]!r}\n'
    f'    }}'
    for d in devices
)

if default_extension == "YOUR_EXTENSION":
    # No real extension known - don't seed "me"/"myself" with a placeholder
    # that would silently pass through resolve_contact() and hit the API
    # as an invalid target. Better to fail fast with "contact_not_found".
    contacts_dict_src = '    # "me"/"myself" not configured - re-run install-skill.sh with\n    # --extension <your-phone-or-extension> to enable "call me"'
else:
    contacts_dict_src = f'    "me": {default_extension!r},\n    "myself": {default_extension!r},'

device_table_rows = '\n'.join(
    f'| **{d["name"]}** | {d["extension"]} | Configured | {d["description"]} |'
    for d in devices
)

# ---------------- lib/api.py ----------------
api_py = f'''"""
Voice API Client
HTTP wrapper for the outbound call API
"""

import json
import urllib.request
import urllib.error
from typing import Optional, Dict, Any

# ============================================================
# CONFIGURATION - generated by install-skill.sh
# Re-run install-skill.sh (or edit directly) if your deployment changes.
# ============================================================

API_BASE_URL = {api_url!r}
# Caller ID shown to whoever picks up. Optional - the voice API rejects it
# if present but not valid E.164, so leave it None unless you have a real
# value (it is NOT the same as CONTACTS["me"] or a device's extension).
DEFAULT_CALLER_ID = None
TIMEOUT_SECONDS = 30

# Contact Directory - Map names/aliases to phone numbers
CONTACTS = {{
{contacts_dict_src}
    # Add your own contacts here:
    # "wife": "+15551234567",
    # "office": "5000",
}}

# Device Registry - AI personalities
DEVICES = {{
{devices_dict_src}
}}

DEFAULT_DEVICE = {default_device_name!r}

# ============================================================
# EXCEPTIONS
# ============================================================

class VoiceAPIError(Exception):
    """Base exception for Voice API errors"""
    def __init__(self, error: str, message: str, data: Optional[Dict] = None):
        self.error = error
        self.message = message
        self.data = data or {{}}
        super().__init__(message)

class ContactNotFoundError(VoiceAPIError):
    pass

class ServiceUnavailableError(VoiceAPIError):
    pass

class CallFailedError(VoiceAPIError):
    pass

class DeviceNotFoundError(VoiceAPIError):
    pass

# ============================================================
# CONTACT RESOLUTION
# ============================================================

def resolve_contact(target: str) -> str:
    """Resolve a contact name/alias to a phone number."""
    target_lower = target.lower().strip()

    # Check contact directory
    if target_lower in CONTACTS:
        return CONTACTS[target_lower]

    # Check if it's already a valid phone number
    cleaned = target.replace("-", "").replace(" ", "").replace("(", "").replace(")", "")

    # E.164 format: +[digits]
    if cleaned.startswith("+") and cleaned[1:].isdigit() and len(cleaned) > 2:
        return cleaned

    # Extension or dial string
    if cleaned.isdigit() and 1 <= len(cleaned) <= 15:
        return cleaned

    raise ContactNotFoundError(
        error="contact_not_found",
        message=f"Unknown contact: {{target}}"
    )

def resolve_device(device: Optional[str]) -> str:
    """Resolve device name to canonical form."""
    if device is None or device.strip() == "":
        return DEFAULT_DEVICE

    device_lower = device.lower().strip()

    if device_lower in DEVICES:
        return DEVICES[device_lower]["name"]

    available = ', '.join(d['name'] for d in DEVICES.values())
    raise DeviceNotFoundError(
        error="device_not_found",
        message=f"Unknown device: {{device}}. Available: {{available}}"
    )

# ============================================================
# MESSAGE SANITIZATION
# ============================================================

def sanitize_message(message: str, max_words: int = 200) -> str:
    """Sanitize a message for TTS delivery."""
    import re

    # Remove code blocks
    message = re.sub(r'```[\\s\\S]*?```', '[code omitted]', message)
    message = re.sub(r'`[^`]+`', '', message)

    # Remove URLs
    message = re.sub(r'https?://\\S+', '[link omitted]', message)

    # Remove special characters
    message = re.sub(r'[{{}}\\[\\]<>|\\\\^~]', '', message)

    # Normalize whitespace
    message = ' '.join(message.split())

    # Truncate
    words = message.split()
    if len(words) > max_words:
        message = ' '.join(words[:max_words]) + '...'

    return message.strip()

# ============================================================
# API CALLS
# ============================================================

def initiate_call(to: str, message: str, caller_id: Optional[str] = DEFAULT_CALLER_ID,
                  mode: str = "announce", device: Optional[str] = None) -> Dict[str, Any]:
    """Initiate an outbound call via the Voice API."""
    url = f"{{API_BASE_URL}}/api/outbound-call"

    payload = {{
        "to": to,
        "message": sanitize_message(message),
        "mode": mode,
        "device": resolve_device(device)
    }}
    # Only include callerId when explicitly set - the API rejects it if
    # present but not a valid E.164 number, so omitting is safer than a bad default.
    if caller_id:
        payload["callerId"] = caller_id

    try:
        request_body = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            url,
            data=request_body,
            headers={{'Content-Type': 'application/json'}},
            method='POST'
        )

        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            result = json.loads(response.read().decode('utf-8'))

            if result.get('success'):
                return {{
                    "callId": result.get('callId'),
                    "to": to,
                    "device": payload['device'],
                    "mode": mode,
                    "status": result.get('status', 'initiated'),
                }}
            else:
                raise CallFailedError(
                    error=result.get('error', 'call_failed'),
                    message=result.get('message', 'Call initiation failed')
                )

    except urllib.error.URLError as e:
        raise ServiceUnavailableError(
            error="service_unavailable",
            message=f"Voice server not reachable: {{str(e.reason)}}"
        )

def get_call_status(call_id: str) -> Dict[str, Any]:
    """Get the status of an existing call."""
    url = f"{{API_BASE_URL}}/api/call/{{call_id}}"

    req = urllib.request.Request(url, method='GET')
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode('utf-8'))

def list_calls() -> Dict[str, Any]:
    """List all active calls."""
    url = f"{{API_BASE_URL}}/api/calls"

    req = urllib.request.Request(url, method='GET')
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode('utf-8'))
'''

with open(os.path.join(skill_dir, 'lib', 'api.py'), 'w') as f:
    f.write(api_py)

# ---------------- bin/call ----------------
bin_call = '''#!/usr/bin/env python3
"""Call Skill CLI - Initiate outbound voice calls"""

import sys
import os
import json
import argparse

# Add lib to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))

from api import (
    resolve_contact,
    initiate_call,
    get_call_status,
    list_calls,
    CONTACTS,
    DEVICES,
    VoiceAPIError,
    ContactNotFoundError,
    ServiceUnavailableError,
    CallFailedError,
    DeviceNotFoundError,
)


def output_success(data):
    print(json.dumps({"ok": True, "data": data}, indent=2))
    sys.exit(0)


def output_error(error: str, message: str, code: int = 1):
    print(json.dumps({"ok": False, "error": error, "message": message}, indent=2))
    sys.exit(code)


def cmd_outbound(args):
    try:
        phone_number = resolve_contact(args.target)
        message = args.message or "This is an automated call from your server."
        mode = args.mode or "announce"

        result = initiate_call(phone_number, message, mode=mode, device=args.device)
        output_success(result)

    except (ContactNotFoundError, ServiceUnavailableError,
            CallFailedError, DeviceNotFoundError) as e:
        output_error(e.error, e.message)
    except Exception as e:
        output_error("unexpected_error", str(e))


def cmd_status(args):
    try:
        result = get_call_status(args.call_id)
        output_success(result)
    except Exception as e:
        output_error("error", str(e))


def cmd_list(args):
    try:
        result = list_calls()
        output_success(result)
    except Exception as e:
        output_error("error", str(e))


def cmd_contacts(args):
    numbers = {}
    for alias, number in CONTACTS.items():
        if number not in numbers:
            numbers[number] = []
        numbers[number].append(alias)

    contacts = [{"number": n, "aliases": a} for n, a in numbers.items()]
    output_success({"contacts": contacts})


def cmd_devices(args):
    devices = [
        {"name": d["name"], "extension": d["extension"], "description": d["description"]}
        for d in DEVICES.values()
    ]
    output_success({"devices": devices})


def main():
    parser = argparse.ArgumentParser(description="Outbound voice calls via SIP")
    subparsers = parser.add_subparsers(dest='command')

    # outbound
    p = subparsers.add_parser('outbound')
    p.add_argument('target', help='Contact name or phone number')
    p.add_argument('--message', '-m', help='Message to speak')
    p.add_argument('--device', '-d', help='Device personality')
    p.add_argument('--mode', choices=['announce', 'conversation'], default='announce')
    p.set_defaults(func=cmd_outbound)

    # status
    p = subparsers.add_parser('status')
    p.add_argument('call_id')
    p.set_defaults(func=cmd_status)

    # list
    p = subparsers.add_parser('list')
    p.set_defaults(func=cmd_list)

    # contacts
    p = subparsers.add_parser('contacts')
    p.set_defaults(func=cmd_contacts)

    # devices
    p = subparsers.add_parser('devices')
    p.set_defaults(func=cmd_devices)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == '__main__':
    main()
'''

with open(os.path.join(skill_dir, 'bin', 'call'), 'w') as f:
    f.write(bin_call)
os.chmod(os.path.join(skill_dir, 'bin', 'call'), 0o755)

# ---------------- SKILL.md ----------------
skill_md = f'''---
name: Call
description: Outbound voice calling via SIP. USE WHEN user says call me, phone me, ring me, notify by phone, or wants the server to call them.
---

# Call Skill

Initiate outbound phone calls to deliver voice messages OR start two-way conversations.

## Call Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **announce** | One-way: Plays message, then hangs up | Notifications, alerts |
| **conversation** | Two-way: Plays message, then conversation | Complex updates, Q&A |

## CLI Usage

```bash
# Basic call
call outbound me --message "Your backup is complete"

# With specific device personality
call outbound me --message "Storage alert!" --device {devices[0]["name"]}

# Conversation mode
call outbound me --message "Let's discuss" --mode conversation

# List devices
call devices
```

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "call me", "phone me", "notify by call" | MakeCall |

## Contact Directory

| Name | Aliases | Number |
|------|---------|--------|
| Me | me, myself | {default_extension} |

## Device Directory

| Device | Extension | Voice | Description |
|--------|-----------|-------|-------------|
{device_table_rows}

## Examples

**Call when task completes:**
```
User: "Run this script and call me when it's done"
→ Executes script, then calls with status update
```

**Call with conversation:**
```
User: "Call me and let's discuss the test results"
→ Calls in conversation mode, you can ask follow-up questions
```

**Device-specific call:**
```
User: "Have {default_device_name} call me about disk usage"
→ {default_device_name}'s voice delivers the message
```
'''

with open(os.path.join(skill_dir, 'SKILL.md'), 'w') as f:
    f.write(skill_md)

# ---------------- workflows/MakeCall.md ----------------
make_call_md = f'''# MakeCall Workflow

Step-by-step procedure for initiating an outbound call.

## Prerequisites

- Voice server running at configured URL ({api_url})
- Valid contact or phone number
- Message to deliver

## Steps

### Step 1: Parse Intent

Identify from user request:
1. **Who to call** - Contact name, alias, or phone number
2. **What to say** - Explicit message or generate from context
3. **Mode** - Announce (one-way) or conversation (two-way)
4. **Device** - Which AI personality (default: {default_device_name})

### Step 2: Resolve Contact

Check contact directory, then validate as phone number:

```python
# Contact lookup
"me" → "{default_extension}"

# Or direct number
"+15551234567" → "+15551234567"
```

### Step 3: Generate Message

If no explicit message:
- Summarize current task/conversation
- Keep under 50 words
- Format: "[Context]. [Result]. [Action if needed]."

### Step 4: Execute Call

```bash
call outbound <number> --message "<message>" [--mode conversation] [--device {devices[0]["name"]}]
```

### Step 5: Report Result

**Success:** "Calling [contact] now. Message: [summary]..."
**Failure:** "Failed to place call: [error]"

## Error Handling

| Error | Response |
|-------|----------|
| contact_not_found | "I don't have a number for [name]" |
| service_unavailable | "The voice server isn't responding" |
| call_failed | "The call couldn't be connected" |
'''

with open(os.path.join(skill_dir, 'workflows', 'MakeCall.md'), 'w') as f:
    f.write(make_call_md)

print(f"✓ Wrote skill files to {skill_dir}")
print(f"  API_BASE_URL = {api_url}")
print(f"  Default contact 'me' -> {default_extension}")
print(f"  Devices: {', '.join(d['name'] for d in devices)}")
PYEOF

echo "$FINGERPRINT" > "$SKILL_DIR/.install-meta"

echo ""
echo "════════════════════════════════════════════"
echo "✓ Call skill installed at $SKILL_DIR"
echo "════════════════════════════════════════════"
echo ""

if [[ "$API_URL" == "http://YOUR_SERVER:3000" ]]; then
  echo "⚠  Could not auto-detect the voice server URL (no .env found)."
  echo "   Edit $SKILL_DIR/lib/api.py and set API_BASE_URL manually."
fi
if [[ "$EXTENSION" == "YOUR_EXTENSION" ]]; then
  echo "⚠  Could not auto-detect a default extension (no devices.json found)."
  echo "   Edit $SKILL_DIR/lib/api.py and set CONTACTS['me'] manually."
fi

echo "Test it:"
echo "  $SKILL_DIR/bin/call devices"
echo "  $SKILL_DIR/bin/call outbound me --message \"Test call from install-skill.sh\""
echo ""
echo "Claude Code picks up skills from ~/.claude/skills automatically -"
echo "no restart needed for new sessions."
