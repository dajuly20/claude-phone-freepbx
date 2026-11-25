# Claude-Instanzen

Jeder Unterordner ist eine Claude-Code-Instanz, die als eigener Container
(`agent-<name>` in `docker-compose.yml`) läuft. Der Ordner wird als
Arbeitsverzeichnis nach `/agent` gemountet.

| Datei | Bedeutung |
|---|---|
| `CLAUDE.md` | Persönlichkeit, Aufgaben, Regeln |
| `.claude/settings.json` | Rechte (erlaubte/verbotene Tools), wie bei Claude Code üblich |
| weitere Dateien | alles, was der Agent lesen soll (Doku, Skripte …) |

Das Modell wird pro Service über `CLAUDE_MODEL` in der Compose-Datei gesetzt.
Anmeldung: `ANTHROPIC_API_KEY` oder `CLAUDE_CODE_OAUTH_TOKEN` in `.env`.

## Rechte-Modus

| `CLAUDE_SKIP_PERMISSIONS` | Verhalten |
|---|---|
| nicht gesetzt (Standard) | `--dangerously-skip-permissions`: alles erlaubt außer `deny` in `settings.json` |
| `"false"` | nur, was `allow` in `settings.json` erlaubt, alles andere wird abgelehnt |

Agents, die wirklich etwas schalten können (z.B. `homeassistant`), laufen mit `"false"`
und bekommen ein einzelnes Werkzeug, das selbst noch einmal prüft (`bin/ha`).

| Agent | Nebenstelle | Werkzeuge |
|---|---|---|
| `vermittlung` | 700 | keine (nur Text, Durchstellen per `🔀 TRANSFER`) |
| `netzwerk` | 702 | noch nicht eingerichtet |
| `homeassistant` | 703 | nur `bin/ha`, Grenzen in `permissions.json` |
