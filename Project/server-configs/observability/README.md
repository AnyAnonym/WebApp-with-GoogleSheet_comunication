# ePiber Observability

Diese Vorlagen betreiben eine gemeinsame Observability fuer Live, PAJ und PK auf
demselben Host. Alle internen Netzwerklistener binden ausschliesslich an
`127.0.0.1`; Grafana selbst verwendet nur einen geschuetzten Unix-Socket.

## Topologie

```text
epiber-{piber,paj,pk}.service --journald--+
Caddy-Access-Logs ------------------------+--> Alloy --> Loki ----+
Backend /metrics ----------------------------> Prometheus --------+--> Grafana
Node Exporter ----------------------------------------------------+
```

- Grafana: `/run/epiber-observability/grafana.sock`, extern `https://epiber.at/grafana/`
- Grafana-Metrikproxy: Caddy `127.0.0.1:3001`, ausschliesslich `/metrics`
- Loki: `127.0.0.1:3100`
- Prometheus: `127.0.0.1:9090`
- Node Exporter: `127.0.0.1:9100`
- Alloy: `127.0.0.1:12345`
- Grafana-Auth-Broker: `127.0.0.1:8085`
- Backendmetriken: Live `:8080/metrics`, PAJ `:8083/metrics`, PK `:8084/metrics`

PAJ `https://epiber.at:8081/grafana/` und PK
`https://epiber.at:8082/grafana/` leiten zur kanonischen Live-Adresse weiter.
Grafana besitzt nur diese eine `root_url`; dadurch bleiben Redirects, Assets,
Cookies, CSP und Grafana-Live-WebSockets eindeutig.

## Zugriff

Caddy prueft jeden Grafana-Request ueber den gemeinsamen Auth-Broker. Der Broker
reicht jedes vorhandene Sessioncookie ausschliesslich an sein eigenes Backend
`GET /api/admin/grafana-auth` weiter. Eine aktuelle aktive Adminsession aus Live,
PK oder PAJ genuegt. Bei mehreren gueltigen Sessions gilt die feste Prioritaet
Live, PK, PAJ. Browserseitige `X-WEBAUTH-USER`- und `X-WEBAUTH-ROLE`-Werte sind
keine Autoritaet.

Grafana verwendet `epiber-<Instanz>:<Personen-ID>` als Benutzernamen. Jeder
zugelassene ePiber-Admin erhaelt in der einzigen Organisation die Grafana-Rolle
`Admin`, aber keine Serveradminrechte, und darf Metriken und Logs aller drei
Systeme sehen. Prometheus und Loki sind nicht editierbare Datenquellen. Loki
verwendet bewusst einen gemeinsamen Tenant; `deployment=live|paj|pk` ist ein
Abfragefilter und keine Berechtigungsgrenze.

Anonyme Anmeldung, Registrierung, oeffentliche Dashboards, Snapshots,
Pluginverwaltung, automatische Plugininstallation und Pluginupdates sind
deaktiviert. Grafana akzeptiert keine TCP-Verbindung; der Socket gehoert der
Caddy-Vertrauensgrenze und ist nur fuer Caddy und Grafana zugaenglich. Alloy liest
Access-Logs ueber die separate Gruppe `grafana-alloy` und kann den Socket nicht
oeffnen. Der Auth-Broker bleibt auf Loopback und akzeptiert keine Identitaet ohne
positive current-only Backendpruefung.

## Daten und Aufbewahrung

Alloy sammelt ausschliesslich:

- die Journale von `epiber-piber.service`, `epiber-paj.service` und
  `epiber-pk.service`;
- das Journal von `epiber-grafana-auth.service`;
- `/var/log/caddy/epiber-{live,paj,pk}-access.json`.

Caddy entfernt Querystrings, Header und Quelladressen. Personen-ID, Klarname,
E-Mail, IP, Support-/Request-ID, Session-, Client- und Geraetewerte bleiben
JSON-Felder und werden keine Loki- oder Prometheus-Labels. Normale Betriebsdaten
und Frontenddiagnose bleiben maximal 14 Tage, gezielte Frontenddiagnose 7 Tage.
Prometheus verwendet 30 Tage und maximal 5 GiB; die tatsaechliche Reichweite ist
bei Erreichen der Groessenbegrenzung kuerzer.

Score- und Auditfachhistorien bleiben ausschliesslich in ihren ePiber-SQLite-
Dateien System of Record. Grafana speichert Benutzer, Dashboards und 30 Tage
Alarmzustandshistorie getrennt in `/var/lib/grafana/grafana.db` mit WAL.

## Dashboards und Alerts

Vier nicht personenbezogene Dashboards werden provisioniert: Uebersicht,
Hostressourcen, Loggingpipeline sowie Fehler/Recovery. Anwendungsdashboards
besitzen die feste Auswahl `live|paj|pk`; Hostmetriken werden nur einmal gezeigt.

Anwendungsalerts erzeugen je Deployment getrennte Alarmzustaende. Host- und
Observability-Alarme existieren einmal. SMTP ist zwingend deaktiviert. Es gibt
keine E-Mail, keinen aktiven Benachrichtigungsweg und keine garantierte Reaktion;
benannte Administratoren kontrollieren Alarmzustaende und ihre 30-Tage-Historie
manuell.

## Installation

Arch-Pakete:

```text
grafana grafana-alloy loki prometheus prometheus-node-exporter
```

Vor dem Lauf muessen alle drei ePiber-Backends denselben freigegebenen Stand mit
internem `/metrics` ausliefern. PK muss auf `127.0.0.1:8084` gesund sein. Die
root-only Datei `/etc/epiber-observability/grafana.env` wird einmalig aus
`grafana/grafana.env.example` angelegt und erhaelt Modus 0600. Adminpasswort und
Secret-Key werden bei Wiederholung nicht geaendert; insbesondere darf der
Secret-Key einer bestehenden `grafana.db` nicht beilaufig rotiert werden.

```text
sh Project/server-configs/observability/install-observability.sh
```

Das Skript validiert und installiert die gemeinsame Konfiguration, startet die
sechs Observability-Dienste und prueft ihre lokalen Health-/Metrics-Endpunkte. Es
fuehrt kein Hostupgrade aus. Vorher werden aktive Caddy- und Observability-
Konfiguration sowie Grafana-SQLite gesichert und die neue Caddy-Vorlage validiert.
Das Skript installiert Caddy bewusst nicht: Direkt nach seinem erfolgreichen
Lauf wird die bereits validierte Vorlage installiert und Caddy kontrolliert
reloaded. In diesem kurzen Wartungsfenster ist Grafana nicht erreichbar; ePiber
bleibt unabhaengig. Bei Fehler werden Caddy- und Observability-Vorlagen aus dem
unmittelbaren Backup gemeinsam zurueckgerollt.

Das lokale Grafana-Adminpasswort ist ausschliesslich Break-glass. Es wird nur in
einem Wartungsfenster mit gestopptem Normaldienst, deaktiviertem Auth Proxy,
separatem Loopback-Vordergrundprozess und SSH-Tunnel verwendet. Der Normalzugang
verwendet immer eine aktuelle ePiber-Adminsession.

Weitere Betriebsdetails stehen in `Project/server-configs/SERVER-SETUP.txt`, die
verbindliche Abnahme in `Project/server-configs/ROLLOUT-CHECKLIST.md` und
Fehlerablaeufe in `RUNBOOKS.md`.
