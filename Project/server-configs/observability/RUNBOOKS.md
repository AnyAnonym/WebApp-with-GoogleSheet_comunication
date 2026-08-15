# ePiber Observability Runbooks

Alerts enthalten keine personenbezogenen Werte. Logauszuege werden nur von
aktuellen ePiber-Admins in Grafana untersucht und vor Export redigiert. Der
Alert-Labelwert `deployment` bestimmt `live`, `paj` oder `pk`.

Zuordnung:

| Deployment | Backendport | systemd-Unit |
|------------|-------------|--------------|
| `live` | 8080 | `epiber-piber.service` |
| `paj` | 8083 | `epiber-paj.service` |
| `pk` | 8084 | `epiber-pk.service` |

## Backend Down

1. Betroffene Unit mit `systemctl status` und `journalctl -u <unit> --since -10min` pruefen.
2. `curl http://127.0.0.1:<port>/live` ausfuehren.
3. Keine geheimen oder personenbezogenen Zeilen in Tickets kopieren.
4. Bei Deploymentfehler auf den dokumentierten letzten freigegebenen Commit zurueckrollen.

## Not Ready

1. `curl http://127.0.0.1:<port>/metrics` und `epiber_readiness_component_ready` pruefen.
2. Den ungesunden Teil gezielt untersuchen; keine Fachwrites blind wiederholen.

## Sheet Data Stale

1. Betroffene Tabelle und Deployment ueber `epiber_sheet_table_current` bestimmen.
2. Sheet-Pollerfehler und Recovery in Loki mit demselben Deployment suchen.
3. Google-Zugang oder Sheetstruktur pruefen, keine unbekannte Mutation wiederholen.

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
3. Bei Auth-Brokerfehlern `/live` und die drei Backend-Authpfade getrennt pruefen.
4. Bei Loki-, Prometheus- oder Grafana-Ausfall bleibt ePiber unabhaengig; den
   Anwendungsdienst nicht ohne separaten Befund neu starten.

## Host Disk Nearly Full

1. Betroffenes Dateisystem und Inodes pruefen.
2. Loki-, Prometheus-, Caddy-, Journal- und SQLite-Wachstum vergleichen.
3. Keine SQLite-, WAL- oder SHM-Datei bei laufendem Dienst manuell loeschen.
