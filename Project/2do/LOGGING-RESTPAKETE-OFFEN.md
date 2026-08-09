# Logging-Restpakete offen

Stand: 08.08.2026

## Paket 4: Metriken und zentrale Auswertung

Noch nicht umgesetzt und weiterhin gesondert zu planen:

- Prometheus-`/metrics` mit bewusst kleiner, nicht personenbezogener Metrikmenge.
- Node Exporter und systembezogene Kapazitaets-/Dateisystemmetriken.
- Grafana-Dashboards und Alertregeln fuer Verfuegbarkeit, Fehlerfolgen,
  Polleralter, SQLite-Fehler und Ressourcenengpaesse.
- Loki/Alloy fuer zentrale strukturierte Logsuche inklusive Transport-,
  Zugriffsschutz-, Aufbewahrungs- und Redaction-Konzept.
- Caddy-Access-Logs mit abgestimmtem Datenschutz- und Retentionkonzept.
- Der Frontend-Collector und die serverseitig angereicherten
  `frontend_client_event`-Zeilen sind umgesetzt. Offen bleiben Alloy-Transport,
  Loki-Retention fuer `frontend_normal`/`frontend_targeted`, Grafana-Dashboards,
  Betreiberrollen und produktive Such-/Alertabnahme.
- Personen-ID, Klarname, IP, Support-ID und ephemere Seitensitzung duerfen in Loki
  nur JSON-Felder sein; als Labels sind ausschliesslich niedrig-kardinale Werte
  wie Instanz, Event, Level, serverseitig begrenzte Seite, Serverversion,
  Versionsuebereinstimmung und Diagnoseprofil vorgesehen. Die vom Browser
  gemeldete Version bleibt ebenfalls nur ein JSON-Feld.

## Paket 5: Praktische Rolloutabnahme

Die automatisierten Tests ersetzen nicht folgende PAJ-/PK-/Live-Pruefungen:

- journald-Drop-in installieren, journald neu starten und Rotation/Retention
  sowie Rate-Limits auf dem Zielsystem pruefen.
- Request-ID-Suche ueber Caddy, Backend-Journal und Clientfehler praktisch
  nachvollziehen.
- Frontend-Policy-Verteilung, anonyme Abschaltung, Zielablauf, sichtbaren
  Benutzerhinweis, Collector-Rate-Limit und Suche nach ID/Name/IP praktisch
  abnehmen.
- Sheet- und Court-Ausfall, periodische Unterdrueckung, Recovery und
  Readiness-Uebergaenge unter realen Intervallen beobachten.
- `/status` mit gueltiger Adminsession bei kuenstlich stale Personenquelle und
  nach Sessionablauf praktisch pruefen.
- Dauerbetrieb, SIGTERM-Drain, SQLite-Backup/Restore, Speicherplatzwarnung und
  Rollback auf PAJ, danach PK und Live abnehmen.

Die kanonische praktische Checkliste bleibt
`Project/server-configs/ROLLOUT-CHECKLIST.md`.

## Weitere offene Governance

- Fuer personenbezogene Auditdaten existiert weiterhin keine automatische
  Loeschung oder Anonymisierung. Ein spaeteres Verfahren muss SQLite-Dateien und
  vorhandene Backups gemeinsam behandeln.
- Kryptografische Manipulationsnachweise fuer Audit- oder Scorehistorien sind
  nicht umgesetzt.
- Historische Logging-/ScoreLog-Sheetzeilen werden nicht automatisch importiert;
  ihre getrennte Archivierung bleibt eine betriebliche Aufgabe.
