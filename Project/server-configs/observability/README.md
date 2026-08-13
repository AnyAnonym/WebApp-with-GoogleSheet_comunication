# PAJ Observability

Diese Vorlagen installieren die zentrale Observability ausschliesslich fuer PAJ.
PK und Live sind nur unter `prometheus/targets/available/` vorbereitet und werden
weder gescrapt noch anderweitig veraendert.

Festgelegte Architektur:

- Grafana, Loki, Prometheus, Alloy und Node Exporter laufen auf demselben Host.
- Alle Observability-Listener binden ausschliesslich an `127.0.0.1`.
- Grafana wird vorerst nur per SSH-Tunnel erreicht; Caddy veroeffentlicht Grafana
  und `/metrics` nicht.
- Prometheus scrapt PAJ direkt unter `127.0.0.1:8083/metrics`.
- Alloy sammelt nur `epiber-paj.service` und das PAJ-Caddy-Access-Log.
- Loki speichert normale Frontenddiagnose 14 Tage und gezielte Diagnose 7 Tage.
- Loki-Zugriff ist nur fuer autorisierte Betreiber vorgesehen. Reine
  Dashboardbenutzer erhalten keinen Loki-Explore-Zugriff. Die Standardorganisation
  erhaelt daher nur Prometheus; `grafana/operators-loki.yml` wird erst nach Anlage
  einer getrennten Betreiberorganisation und Pruefung ihrer `orgId` manuell unter
  Grafanas Datasource-Provisioning installiert.
- Score- und Auditfachhistorien bleiben ausschliesslich in ihren SQLite-Dateien
  System of Record.
- Alerting erfolgt ueber Grafana; Kontaktpunkte und Benachrichtigungsgeheimnisse
  werden ueber eine lokale, nicht versionierte Environment-Datei befuellt.

Arch-Pakete:

```text
grafana grafana-alloy loki prometheus prometheus-node-exporter
```

Das Installationsskript installiert fehlende Pakete mit `pacman -S --needed` und
protokolliert danach die konkret installierten Versionen. Es prueft ausserdem die
lokalen Health-/Metrics-Endpunkte der fuenf gestarteten Dienste; ein fehlgeschlagener
Check beendet den Lauf mit Fehler.

Die Installation benoetigt root. Vorher ist
`/etc/epiber-observability/grafana.env` aus `grafana/grafana.env.example` mit
Modus 0600 und echten lokalen Geheimnissen/Empfaengern anzulegen. `install-paj.sh`
validiert Werkzeuge und Quellvorlagen, installiert die PAJ-Vorlagen und startet
ausschliesslich die PAJ-bezogenen Observability-Dienste. PK-/Live-Anwendungsdienste
und deren Konfigurationen werden nicht veraendert.

Das Skript installiert die Caddy-Vorlage bewusst nicht automatisch. Nach Backup
der aktiven `/etc/caddy/Caddyfile` muss ein autorisierter Betreiber die versionierte
Vorlage separat validieren, installieren und Caddy reloaden. Erst danach liefert
das PAJ-Access-Log Daten an Alloy.

Vor dem ersten produktiven Start sind freie Kapazitaet und konkrete Paketversionen
zu protokollieren. Der aktuelle Vorlagenwert fuer Prometheus-Retention ist 30 Tage;
Loki und Caddy halten PAJ-Betriebsdaten maximal 14 Tage, gezielte Frontenddiagnose
maximal 7 Tage.

Vier nicht personenbezogene Standarddashboards werden provisioniert: Uebersicht,
Ressourcen, Loggingpipeline sowie Fehler/Recovery. Grafana Alerting provisioniert
PAJ-, SQLite-, Sheet-, Metadata- und Speicherregeln. Der lokale Kontaktpunkt muss
vor dem ersten Start praktisch getestet werden.
