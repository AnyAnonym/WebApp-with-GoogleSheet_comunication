# Logging-Umsetzungsplan (ScoreLog/Audit weg von Google Sheets)

## Status 06.08.2026

Etappen A bis D sowie der dokumentierte Querschnitt sind mit Branch-Commit
`4.3.0-paj-1-4` umgesetzt. Die unter "Bewusst außerhalb dieses Branches"
genannten Themen bleiben offen. Verbindliche Testergebnisse stehen im
Branch-Changelog.

## Entscheidungen
1. Monitor-Navigations-/Scrollbefehle **werden** ins Auditlog aufgenommen.
2. **Separate** SQLite-Dateien für Fachhistorie, getrennt vom Anwendungsstate.
3. Google Sheets `ScoreLog` und `Logging` werden nicht mehr beschrieben **und** die Dokumentation wird auf „entfernt" umgestellt.

## Zielbild
- Betriebslogs: strukturiertes JSON auf stdout → journald → optional Loki.
- ScoreLog: System of Record in eigener SQLite-Datei, zusätzlich JSON-Event-Spiegel.
- Auditlog: System of Record in eigener SQLite-Datei, zusätzlich JSON-Event-Spiegel.
- Aufbewahrung: unbegrenzt (Saison-Historie), Sicherung über SQLite-Backups.
- journald bleibt flüchtiger Diagnosekanal; keine Fachhistorie im Ringpuffer.

## Drei getrennte Kanäle

| Kanal | Ziel | Steuerung |
|---|---|---|
| Betriebslog | stdout → journald → (Loki) | `LOG_LEVEL` |
| ScoreLog | eigene SQLite-Datei + JSON-Spiegel | immer persistent; Spiegel abschaltbar |
| Auditlog | eigene SQLite-Datei + JSON-Spiegel | persistent; Aktionsklassen selektiv konfigurierbar |

## Etappe A — Zentraler strukturierter Logger (L4)
- Neues Modul `Backend/logger.js`: `log(level, event, fields)`, eine JSON-Zeile pro Event.
- Pflichtfelder: `timestamp` (UTC ISO-8601), `level`, `service`, `instance` (`INSTANCE_ID`), `version` (`APP_VERSION`), `event`.
- `LOG_LEVEL` in `config.js` (default `info`, PAJ ggf. `debug`).
- Zentrale rekursive Redaction (Deny-Liste: `passwordHash`, `token`, `cookie`, `sid`, `email`, `private_key`, …) plus Feldlängenbegrenzung.
- Fehlerserialisierung (`code`, `name`, `message`, `stack`) nur im geschützten Serverlog.
- Bestehende ~39 `console.*`-Backend-Stellen auf benannte Events migrieren.
- Tests: JSON-Schema, rekursive Redaction, Level-Filter.

## Etappe B — journald-Betrieb (L11, Infra-Doku)
- systemd-Units: `SyslogIdentifier=epiber-<system>`, `LogRateLimitIntervalSec`, `LogRateLimitBurst`.
- journald-Sollstand (`SystemMaxUse`, `MaxRetentionSec`, persistente Speicherung) in `Project/server-configs/` dokumentieren.
- Hinweis: Fachhistorie unabhängig von journald-Rotation, da SQLite System of Record.

## Etappe C — ScoreLog nach SQLite (L8), Sheets-Write entfernen
- Neue **separate** SQLite-Datei, z. B. `SCORELOG_FILE=/var/lib/epiber-<system>/scorelog.sqlite`.
- Tabelle `score_log` (`event_id`, `seq` pro Court, `ts`, `platz`, `score`, `match_id`, `court_active`, `instance`, `created_at`), WAL, `synchronous=FULL`.
- `writeScoreLog()` in `courtPoller.js` von Google-`append` auf geordneten SQLite-Insert umstellen; `lastPersistedScore` erst nach bestätigtem Insert.
- JSON-Event `score_logged` als Spiegel.
- `cleanScore()`-Allowlist enger fassen (Formel-Injection-Risiko entfällt ohnehin mit dem Sheet-Write).
- Tests: Reihenfolge, kein Eintrag bei Freeze/Reset/Baseline, Neustart-Duplikatfreiheit, Insert-Fehlerverhalten.

## Etappe D — Auditlog nach SQLite (L9), Sheets `Logging` ablösen
- Neue **separate** SQLite-Datei, z. B. `AUDITLOG_FILE=/var/lib/epiber-<system>/audit.sqlite`.
- Tabelle `audit_log` (`event_id`, `ts`, `actor_type`, `actor_id`, `role`, `action`, `target_type`, `target_id`, `request_id`, `result`, `before_json`, `after_json`, `instance`).
- Zentrale `audit(...)`-Funktion, aufgerufen aus:
  - Fachwrites: `addMatch`, `addEntryList`, `removeEntryList` (Tombstone), `withdrawFromRanking`, `courtAssign`, `courtSetActive`, `monitorNavigate`, `monitorScroll`, `monitorProvision`, `monitorRotate`, `monitorRevoke`.
  - Auth/Security: Login erfolgreich/fehlgeschlagen, Logout, eigene Passwortänderung, Passwort-Erstvergabe, Admin-Passwortfreigabe, Admin-Passwortsetzung, Monitor-Enrollment.
- Akteur immer aus serverseitiger Session/Principal, nie aus Client-Params.
- `withdrawFromRanking` von Sheet-`Logging` auf `audit_log` umstellen (letzter Sheets-Fachwrite entfällt).
- Diff auf erlaubte Felder begrenzt, keine Geheimnisse.
- Auditpflichtige Aktionsklassen konfigurierbar (selektiv).
- Tests: Auditvollständigkeit je Mutation, Akteurquelle, keine Geheimnisse im Diff, Tombstone bei Löschung.

## Querschnitt
- `/status` optional um flüchtige Zähler ergänzen (letzter ScoreLog-`seq`, Auditzahl) — kein Ersatz für SQLite.
- Doku-Abgleich: `DATENBANK.txt` (neue Dateien/Tabellen), `ENDPOINTS.txt` (ScoreLog/Logging nicht mehr Sheets), `ARCHITEKTUR.txt`, `ROLLOUT-CHECKLIST.md`, `SERVER-SETUP.txt`, `.env.example` (neue Pfade/`LOG_LEVEL`), `Project/2do/LOGGING-ANALYSE-AKTUALISIERT.md`.
- Neue Env-Variablen: `LOG_LEVEL`, `SCORELOG_FILE`, `AUDITLOG_FILE`; `StateDirectory`/Rechte in systemd berücksichtigen.
- Rollout-Checkliste: Sheets-Tabs werden nicht mehr beschrieben; Fachhistorie in SQLite prüfen und sichern.
- Verpflichtendes Branch-Changelog `-x` pflegen.

## Bewusst außerhalb dieses Branches
- Prometheus `/metrics`, Grafana/Loki/Alloy-Installation, Caddy-Access-Logs, Frontend-Fehlererfassung (L13), Frontend-Konsolenbereinigung (L2).

## Empfohlene Reihenfolge
A → B → C → D, danach Doku- und Rollout-Abgleich, dann Tests (`npm run build`).
