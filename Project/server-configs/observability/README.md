# ePiber Observability

Diese Vorlagen betreiben eine gemeinsame Observability fuer Live und PAJ auf
demselben Host. PK bleibt als spaetere Anwendungsvorlage erhalten, ist aber kein
aktives Observability-Deployment. Alle internen Netzwerklistener binden ausschliesslich an
`127.0.0.1`; Grafana selbst verwendet nur einen geschuetzten Unix-Socket.

## Topologie

```text
epiber-{piber,paj}.service --journald-----+
Caddy-Access-Logs ------------------------+--> Alloy --> Loki ----+
Backend /metrics ----------------------------> Prometheus --------+--> Grafana
Node Exporter ----------------------------------------------------+
```

- Grafana: `/run/epiber-observability/grafana.sock`, extern `https://epiber.at/grafana/`
- Grafana-Metrikproxy: Caddy mit explizitem Loopback-Bind auf `127.0.0.1:3001`, ausschliesslich `/metrics`
- Loki: `127.0.0.1:3100`
- Prometheus: `127.0.0.1:9090`
- Node Exporter: `127.0.0.1:9100`
- Alloy: `127.0.0.1:12345`
- Grafana-Auth-Broker: `127.0.0.1:8085`
- Backendmetriken: Live `:8080/metrics`, PAJ `:8083/metrics`

PAJ `https://epiber.at:8081/grafana/` leitet zur kanonischen Live-Adresse weiter.
Die unveraenderte PK-Origin besitzt keine Grafana-Integration. Grafana besitzt
nur diese eine `root_url`; dadurch bleiben Redirects, Assets,
Cookies, CSP und Grafana-Live-WebSockets eindeutig.

## Zugriff

Caddy prueft jeden Grafana-Request ueber den gemeinsamen Auth-Broker. Der Broker
reicht jedes vorhandene Sessioncookie ausschliesslich an sein eigenes Backend
`GET /api/admin/grafana-auth` weiter. Eine aktuelle aktive Adminsession aus Live
oder PAJ genuegt. Bei mehreren gueltigen Sessions gilt die feste Prioritaet Live,
PAJ. PK-Cookies werden nicht ausgewertet. Browserseitige `X-WEBAUTH-USER`- und `X-WEBAUTH-ROLE`-Werte sind
keine Autoritaet.

Grafana verwendet `epiber-<Instanz>:<Personen-ID>` als Benutzernamen. Jeder
zugelassene ePiber-Admin erhaelt in der einzigen Organisation die Grafana-Rolle
`Admin`, aber keine Serveradminrechte, und darf Metriken und Logs von Live und
PAJ sehen. Prometheus und Loki sind nicht editierbare Datenquellen. Loki
verwendet bewusst einen gemeinsamen Tenant; `deployment=live|paj` ist ein
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

- die Journale von `epiber-piber.service` und `epiber-paj.service`;
- das Journal von `epiber-grafana-auth.service`;
- `/var/log/caddy/epiber-{live,paj}-access.json`.

Caddy entfernt Querystrings, Header und Quelladressen. Personen-ID, Klarname,
E-Mail, IP, Support-/Request-ID, Session-, Client- und Geraetewerte bleiben
JSON-Felder und werden keine Loki- oder Prometheus-Labels. Normale Betriebsdaten
und Frontenddiagnose bleiben maximal 14 Tage, gezielte Frontenddiagnose 7 Tage.
Prometheus verwendet 30 Tage und maximal 5 GiB; die tatsaechliche Reichweite ist
bei Erreichen der Groessenbegrenzung kuerzer.

Score- und Auditfachhistorien bleiben ausschliesslich in ihren ePiber-SQLite-
Dateien System of Record. Grafana speichert Benutzer, Dashboards und 30 Tage
Alarmzustandshistorie getrennt in `/var/lib/grafana/grafana.db` mit WAL.
Messaging-Ereignisse, persoenliche Projektionen, Zustellungen und Quittierungen
bleiben ausschliesslich in `messaging.sqlite`; Journal und Prometheus enthalten
nur kontrollierte IDs beziehungsweise aggregierte technische Zaehler.

## Dashboards und Alerts

Acht Dashboards werden provisioniert: Uebersicht, Hostressourcen,
Loggingpipeline, Fehler/Recovery, Personennormalisierung, Ranglistenaktivitaeten,
Matchergebnisse sowie Platz- und Scoreverlauf.
Anwendungsdashboards besitzen die feste Auswahl `live|paj`; Hostmetriken werden
nur einmal gezeigt. Das Normalisierungsdashboard zeigt den aktuellen
aggregierten Problemstand, RPC-/Write-Ergebnisse und technische Diagnosen ohne
Personenbezug. Es zeigt zusaetzlich die aktiven Mitglieder insgesamt und getrennt
nach `player`, `player A` und `player B`; die Gesamtzahl ist die Summe dieser drei
Klassifikationen und schliesst Admins sowie Operatoren aus. Das Gauge
`epiber_people_normalization_active_members` verwendet dafuer ausschliesslich das
kontrollierte Label `classification=player|player_a|player_b` und keine
Personenwerte. Nur der ausdrueckliche Auditverlauf enthaelt den ausfuehrenden
Adminnamen samt Admin-ID sowie Ziel-Personen-ID und resultierenden Vor-/Nachnamen.
Fuer `Aktiv` und `Rolle` erscheinen kontrollierte Alt-/Neuwerte; bei allen
anderen Normalisierungsfeldern nur der Feldname. Kontakt-, Adress-, Geburts-,
Geschlechts-, sonstige Vorher-/Nachher- und freie Fachdaten werden dort nicht
dargestellt.

Das Hostressourcen-Dashboard formatiert CPU, RAM, freien Speicher, Inodes und
Netzwerkdurchsatz mit passenden dynamischen Einheiten und zeigt die aktuellen
Werte zusaetzlich in den Tabellenlegenden. Readiness und SQLite-Panels fuehren
Messaging als eigene kontrollierte Komponente beziehungsweise Datenbank. Die
Metriken `epiber_readiness_component_ready{component="messaging_sqlite"}`,
`epiber_sqlite_ready{database="messaging"}` und
`epiber_sqlite_failures_total{database="messaging"}` besitzen keine Personen-,
Ereignis-, Meldungs- oder Textlabels.

Das Dashboard `ePiber Platz- und Scoreverlauf` zeigt fuer das ausgewaehlte
Deployment und optional einen einzelnen Platz die neuesten Ereignisse zuerst.
Persistierte Scoreaenderungen werden mit ihrer platzbezogenen Folgenummer
dargestellt. Court-Snapshots ergaenzen Zuweisung, Aktivierung, Deaktivierung,
Prozessstart und die erste nach einem Start uebernommene externe Baseline. Die
Loki-Projektion enthaelt ausschliesslich Platz, Score, Match-ID, Bewerb-ID und
-bezeichnung, Anzeigenamen der Heim-/Gastpaarung, Aktivstatus und Court-Revision.
Diese Werte bleiben JSON-Felder; Match-, Bewerbs- und Personenwerte werden keine
Labels. Kontakt-, Adress-, Geburts-, Geschlechts- und freie Werte sind
ausgeschlossen. Die Ansicht reicht hoechstens 14 Tage zurueck und ersetzt nicht
die dauerhafte Scorefachhistorie in `scorelog.sqlite`.

Das Dashboard `ePiber Ranglistenaktivitaeten` zeigt verbindlich ausgesprochene
Forderungen getrennt von Versuchen, bei denen keine Forderung angelegt wurde,
und von unklaren Schreibausgaengen. Ein nicht angelegter Versuch ist keine
Ablehnung durch den Geforderten. Der Auditverlauf enthaelt auf ausdruecklichen
Wunsch Forderer- und Zielname samt stabilen IDs, Bewerb-ID, bei Erfolg die
Match-ID, kontrollierten Fehlercode und Support-ID. Diese Werte bleiben
JSON-Felder und werden keine Loki-Labels. Kontaktwerte und freie Inhalte sind
ausgeschlossen; die Ansicht reicht hoechstens 14 Tage zurueck und ersetzt nicht
die dauerhafte Historie in `audit.sqlite`.

Das Dashboard `ePiber Matchergebnisse` zeigt erfolgreiche Ergebniseintraege,
Korrekturen, Ruecknahmen und MatchEnd-Korrekturen sowie fehlgeschlagene, unklare
und technisch problematische Ausgaenge. Der optionale Bewerbsfilter arbeitet auf
dem geparsten JSON-Feld `competitionId`; Match-, Bewerbs-, KO-Ziel-, Akteur- und
Request-IDs bleiben JSON-Felder und werden keine Loki-Labels. Der Auditverlauf
verwendet nur `matchId`, `competitionId`, `changeType`, `completionType`,
`source`, `shiftedCount`, `koTargetMatchId`, `koTargetStatus`, `actorName`,
`actorId`, `result`, `errorCode` und `requestId`. Begruendungstexte, rohe Matchergebnisse, Payloads,
Kontaktdaten, Passwoerter und Tokens sind ausgeschlossen. Die Ansicht reicht
hoechstens 14 Tage zurueck und ersetzt nicht die dauerhafte Historie in
`audit.sqlite`.

Die Uebersicht zeigt zusaetzlich den verbleibenden Google-Sheets-Read-Cooldown,
die tatsaechlichen API-Versuche sowie logische Readrequests nach festem Zweck und
Ergebnis. Methoden, Zwecke, Ergebnisse und `initial|retry` sind kontrollierte
niedrig-kardinale Labels; Tabellenbereiche, Personen-, Record-, Request- und
Operation-IDs bleiben ausgeschlossen. Das Gauge
`epiber_sheet_refreshes_scheduled` zeigt die Anzahl geplanter zusammengefasster
Abschlussrefreshes ohne Tabellen- oder Personenlabel. Ein Google-429 startet einen gemeinsamen
60-Sekunden-Cooldown und wird dadurch nicht mit weiteren Poll- oder Fachreads
verstaerkt.

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

Vor dem Lauf muessen Live und PAJ denselben freigegebenen Stand mit internem
`/metrics` ausliefern. PK wird weder geprueft noch gescraped. Die
root-only Datei `/etc/epiber-observability/grafana.env` wird einmalig aus
`grafana/grafana.env.example` angelegt und erhaelt Modus 0600. Adminpasswort und
Secret-Key werden bei Wiederholung nicht geaendert; insbesondere darf der
Secret-Key einer bestehenden `grafana.db` nicht beilaufig rotiert werden.

```text
sh Project/server-configs/observability/install-observability.sh
```

Das Skript validiert und installiert die gemeinsame Konfiguration, startet die
sechs Observability-Dienste und prueft ihre lokalen Health-/Metrics-Endpunkte. Es
fuehrt kein Hostupgrade aus. Der Betreiber muss aktive Caddy- und Observability-
Konfiguration sowie Grafana-SQLite vorher konsistent sichern und die neue
Caddy-Vorlage separat validieren; das Skript erstellt oder prueft keine Backups.
Das Skript installiert Caddy bewusst nicht: Direkt nach seinem erfolgreichen
Lauf wird die bereits validierte Vorlage installiert und Caddy kontrolliert
reloaded. In diesem kurzen Wartungsfenster ist Grafana nicht erreichbar; ePiber
bleibt unabhaengig. Bei Fehler muss der Betreiber Caddy- und Observability-
Vorlagen aus dem geprueften unmittelbaren Backup gemeinsam zurueckrollen.

Das lokale Grafana-Adminpasswort ist ausschliesslich Break-glass. Es wird nur in
einem Wartungsfenster mit gestopptem Normaldienst, deaktiviertem Auth Proxy,
separatem Loopback-Vordergrundprozess und SSH-Tunnel verwendet. Der Normalzugang
verwendet immer eine aktuelle ePiber-Adminsession.

Weitere Betriebsdetails stehen in `Project/server-configs/SERVER-SETUP.txt`, die
verbindliche Abnahme in `Project/server-configs/ROLLOUT-CHECKLIST.md` und
Fehlerablaeufe in `RUNBOOKS.md`.
