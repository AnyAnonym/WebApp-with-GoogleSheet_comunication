# PAJ Observability

Diese Vorlagen installieren die zentrale Observability ausschliesslich fuer PAJ.
PK und Live sind nur unter `prometheus/targets/available/` vorbereitet und werden
weder gescrapt noch anderweitig veraendert.

Festgelegte Architektur:

- Grafana, Loki, Prometheus, Alloy und Node Exporter laufen auf demselben Host.
- Alle Observability-Listener binden ausschliesslich an `127.0.0.1`.
- Caddy veroeffentlicht Grafana ausschliesslich fuer PAJ unter
  `https://epiber.at:8081/grafana/`. Jeder Request wird ueber
  `GET /api/admin/grafana-auth` gegen eine aktuelle aktive PAJ-Adminsession
  autorisiert; Browser-Identitaetsheader werden durch die Backendantwort ersetzt.
- Grafana vertraut den Auth-Proxy-Headern nur von Loopback. Die stabile
  instanznamensraeumige Personen-ID `epiber-paj:<Personen-ID>` ist der
  Grafana-Benutzername, PAJ-Admins erhalten die
  Grafana-Organisationsrolle `Admin`, aber keine Grafana-Serveradminrechte.
  Alle lokalen Prozesse gehoeren zur geschuetzten Host-Vertrauensgrenze; der
  Grafana-Loopbackport darf keinem unkontrollierten lokalen Prozess offenstehen.
- Prometheus scrapt PAJ direkt unter `127.0.0.1:8083/metrics`.
- Alloy sammelt nur `epiber-paj.service` und das PAJ-Caddy-Access-Log.
- Loki speichert normale Frontenddiagnose 14 Tage und gezielte Diagnose 7 Tage.
- Loki-Zugriff ist auf aktive PAJ-Admins begrenzt und wird gemeinsam mit
  Prometheus in der einzigen PAJ-Adminorganisation provisioniert.
- Score- und Auditfachhistorien bleiben ausschliesslich in ihren SQLite-Dateien
  System of Record.
- Alerting erfolgt vorerst passiv ueber Grafana. Aktive Zustaende und ihre
  30-Tage-Historie werden als Annotationen in der persistenten Grafana-SQLite
  gespeichert und von verantwortlichen Administratoren manuell kontrolliert.
  SMTP ist technisch deaktiviert; es gibt weder E-Mail-Zustellung noch eine
  garantierte zeitnahe Reaktion.

Arch-Pakete:

```text
grafana grafana-alloy loki prometheus prometheus-node-exporter
```

Die benoetigten Pakete werden im freigegebenen Wartungsfenster mit einem
vollstaendigen `pacman -Syu --needed` installiert. Das Installationsskript fuehrt
selbst kein weiteres Host-Upgrade aus, protokolliert die konkret installierten
Versionen und prueft die
lokalen Health-/Metrics-Endpunkte der fuenf gestarteten Dienste; ein fehlgeschlagener
Check beendet den Lauf mit Fehler.

Die Installation benoetigt root. Vorher ist
`/etc/epiber-observability/grafana.env` aus `grafana/grafana.env.example` mit
Modus 0600, lokal erzeugtem Notfall-Adminpasswort, Secret-Key und
`GF_SMTP_ENABLED=false` anzulegen. Das Notfallpasswort ist kein normaler
Benutzerzugang und wird nur fuer einen dokumentierten Break-glass-Fall verwahrt.
Bei Wiederholung bleiben Adminpasswort und Secret-Key unveraendert; insbesondere
darf der Secret-Key einer bestehenden `grafana.db` nicht beilaufig rotiert werden.
`install-paj.sh`
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
PAJ-, SQLite-, Sheet-, Metadata- und Speicherregeln. Vor der Freigabe muessen ein
kontrollierter Alarm und seine Recovery in der Grafana-Historie sichtbar sein,
ohne dass ein Benachrichtigungsversuch ausgeloest wird.
