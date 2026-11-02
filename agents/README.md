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
Anmeldung: `CLAUDE_CODE_OAUTH_TOKEN` in `.env` (erzeugen mit `claude setup-token`).
