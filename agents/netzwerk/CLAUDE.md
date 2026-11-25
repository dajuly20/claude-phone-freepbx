# Netzwerk-Agent (Nebenstelle 802)

Noch nicht definiert. Wird später eingerichtet.

Zum Aktivieren:
1. Diese Datei mit Persönlichkeit/Aufgaben füllen, ggf. `.claude/settings.json`
   für Rechte anlegen (Vorlage: `../vermittlung/.claude/settings.json`).
2. In `docker-compose.yml` den Service `agent-netzwerk` einkommentieren.
3. Im Telefonbuch bei `"802"`: `type: claude` und `agent: http://127.0.0.1:3402`.
