# ePiber Observability Runbooks

Alerts enthalten keine personenbezogenen Werte. Logauszuege werden nur von
aktuellen ePiber-Admins in Grafana untersucht und vor Export redigiert. Der
Alert-Labelwert `deployment` bestimmt im aktiven Stand `live` oder `paj`.

Zuordnung:

| Deployment | Backendport | systemd-Unit |
|------------|-------------|--------------|
| `live` | 8080 | `epiber-piber.service` |
| `paj` | 8083 | `epiber-paj.service` |

PK ist derzeit kein aktives Observability-Deployment und wird erst nach einer
separaten Freigabe wieder in Scrapes, Logs, Authentifizierung und Alerts aufgenommen.

## Backend Down

1. Betroffene Unit mit `systemctl status` und `journalctl -u <unit> --since -10min` pruefen.
2. `curl http://127.0.0.1:<port>/live` ausfuehren.
3. Keine geheimen oder personenbezogenen Zeilen in Tickets kopieren.
4. Bei Deploymentfehler auf den dokumentierten letzten freigegebenen Commit zurueckrollen.

## Not Ready

1. `curl http://127.0.0.1:<port>/metrics` und `epiber_readiness_component_ready` pruefen.
2. Den ungesunden Teil gezielt untersuchen; keine Fachwrites blind wiederholen.

## Sheet Snapshot Missing

1. Betroffene Tabelle und Deployment ueber `epiber_sheet_table_available` bestimmen.
2. `sheets_full_refresh_failed`, `sheets_startup_recovery_scheduled` und
   `sheets_startup_recovery_completed` in Loki fuer dasselbe Deployment pruefen.
3. Google-Zugang, Quote und Sheetstruktur pruefen. Solange noch nie ein
   vollstaendiger Snapshot geladen wurde, bleibt die Anwendung not-ready.
4. Einen manuellen Gesamtimport nur als Admin im Servicebereich starten. Bei
   unklarem Ausgang keine neue operationId erzeugen und keine Fachwrites blind
   wiederholen; Support-ID und Auditstatus verwenden.

## Court Source Stale

1. Courtquelle, Netzwerk und `court_poll_failed` fuer das Deployment pruefen.
2. ScoreLog-Gesundheit getrennt pruefen.

## SQLite Unhealthy

1. Betroffene Datenbank ueber `deployment` und `database` bestimmen.
2. Freien Speicher, Dateirechte und Journal pruefen.
3. Vor Reparatur den Dienst stoppen und eine konsistente Sicherung erstellen.

## Pending Metadata Intent

Die Schritte aus `Project/server-configs/ROLLOUT-CHECKLIST.md`, Abschnitt
`pendingMetadataIntents manuell klaeren`, strikt einhalten. Keine Aktion blind
wiederholen.

## HTTP Server Errors

1. Deployment, Fehlerzeitraum und normalisierte Route in Grafana bestimmen.
2. Zu den strukturierten Backendlogs desselben Deployments wechseln.
3. Support-IDs bleiben JSON-Felder und duerfen nicht in Alerttexte gelangen.

## Observability Target Down

1. Das ausgefallene Ziel mit `up` nach `job` bestimmen.
2. Den zugehoerigen Dienststatus und dessen Journal lokal pruefen.
3. Bei Auth-Brokerfehlern `/live` und die Backend-Authpfade von Live und PAJ getrennt pruefen.
4. Bei Loki-, Prometheus- oder Grafana-Ausfall bleibt ePiber unabhaengig; den
   Anwendungsdienst nicht ohne separaten Befund neu starten.

## Host Disk Nearly Full

1. Betroffenes Dateisystem und Inodes pruefen.
2. Loki-, Prometheus-, Caddy-, Journal- und SQLite-Wachstum vergleichen.
3. Keine SQLite-, WAL- oder SHM-Datei bei laufendem Dienst manuell loeschen.
