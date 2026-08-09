# Logging- und Observability-Restumsetzungsplan

Stand: 09.08.2026
Commitstand der Planerstellung: `4.3.0-paj-1-8`
Status: verbindliche Abarbeitungsgrundlage fuer die noch offenen Logging-,
Metrik-, Dashboard-, Alerting- und Rolloutarbeiten

## 1. Zweck und Verwendung

Dieses Dokument fuehrt den noch offenen Logging- und Observability-Umfang in
einer ausfuehrbaren Reihenfolge zusammen. Es ersetzt keine permanenten
Software-, Endpoint- oder Serververtraege und keine allgemeine
`ROLLOUT-CHECKLIST.md`. Es ist die Arbeitsgrundlage, an der Entscheidungen,
Implementierung, Tests und praktische Abnahmen fuer diesen Restumfang verfolgt
werden.

Fuer die Abarbeitung gelten folgende Regeln:

- [ ] Arbeitspakete werden grundsaetzlich in der hier angegebenen Reihenfolge
  bearbeitet; eine Abweichung wird mit Grund im jeweiligen Ergebnisprotokoll
  festgehalten.
- [ ] Ein Paket gilt erst als erledigt, wenn Aufgaben, Artefakte und
  Abnahmekriterien vollstaendig erfuellt sind.
- [ ] Sicherheits-, Datenschutz- oder Betreiberentscheidungen werden vor der
  davon abhaengigen technischen Umsetzung getroffen, nicht nachtraeglich.
- [ ] Geheimnisse, Cookies, Tokens, Passwortwerte, private Schluessel und
  vollstaendige Request-/Response-Payloads werden weder in Logs noch in
  Metriken, Screenshots oder Abnahmeprotokolle uebernommen.
- [ ] Personenbezogene Diagnosefelder werden nur fuer den Betriebszweck und nur
  autorisierten Rollen zugaenglich gemacht.
- [ ] PAJ ist die erste praktische Zielumgebung. PK und Live folgen erst nach
  bestandenen PAJ-Gates und verwenden denselben freigegebenen Release-Commit.
- [ ] Nach Abschluss eines Arbeitspakets werden Ergebnis, Testnachweise,
  Restpunkte und gegebenenfalls notwendige permanente Dokumentationsaenderungen
  festgehalten.

Statuskennzeichen fuer die Paketuebersicht:

- `OFFEN`: noch nicht begonnen.
- `BLOCKIERT`: eine benannte Entscheidung oder Voraussetzung fehlt.
- `IN ARBEIT`: Umsetzung oder Abnahme laeuft.
- `ABGENOMMEN`: alle Kriterien erfuellt und Nachweis dokumentiert.

## 2. Zielbild

Nach vollstaendiger Umsetzung sollen autorisierte Betreiber:

- strukturierte Backend-, Frontend- und Caddy-Ereignisse zentral und
  instanzuebergreifend in Grafana suchen koennen;
- einen Browserfehler von einer angezeigten Support-ID bis zum passenden HTTP-
  oder WebSocket-Abschluss nachvollziehen koennen;
- Verfuegbarkeit, Readiness, Pollerfrische, Fehlerfolgen, SQLite-Zustand und
  Hostressourcen ohne Zugriff auf personenbezogene Logdetails erkennen koennen;
- definierte Warnungen und kritische Stoerungen ueber dokumentierte
  Eskalationswege erhalten;
- Aufbewahrung, Zugriff und Loeschung entsprechend der vereinbarten Governance
  nachweisbar kontrollieren koennen;
- dieselbe getestete Konfiguration kontrolliert von PAJ ueber PK nach Live
  ausrollen und zurueckrollen koennen.

Die Zielkette ist:

```text
Browserdiagnose -> Backend-Collector -> strukturiertes journald
Backendereignis ----------------------> strukturiertes journald
Caddy-Access-Log ----------------------> kontrolliertes strukturiertes Log
                                         |
                                         v
                                    Grafana Alloy
                                         |
                                         v
                                        Loki
                                         |
                                         v
                                  Grafana Logsuche

Backend /metrics -----> Prometheus -----+
Node Exporter --------> Prometheus -----+--> Grafana Dashboards und Alerts
```

## 3. Bestaetigte Ausgangslage

### 3.1 Bereits umgesetzt und nicht erneut zu implementieren

- Der Backendlogger schreibt strukturierte und redigierte Ereignisse.
- `Frontend/JS/diagnostics.js` ist der zentrale Browserdiagnoseadapter.
- Direkte fachliche `console.*`-Aufrufe ausserhalb des Adapters werden statisch
  verhindert.
- Frontenddiagnose besitzt serverseitig persistierte globale Policies und
  temporaere Zielpersonen.
- `POST /api/frontend-events` nimmt allowlist-basierte technische Ereignisse an.
- Benutzer-ID, Klarname, Rolle und Quell-IP werden fuer Frontendereignisse nur
  serverseitig bestimmt.
- `Frontend/adminLogging.html` konfiguriert Frontenddiagnose. Die Seite ist keine
  Loganzeige und soll nicht zu einer zweiten Logsuchoberflaeche ausgebaut werden.
- HTTP besitzt eine serverseitige `X-Request-ID`; Fehler verwenden dieselbe ID als
  `supportId`.
- WebSocket trennt Client-Request-ID und serverseitige Support-ID.
- HTTP- und korrelierbare WebSocket-Auftraege erzeugen strukturierte
  Abschlussereignisse.
- Sheet- und Court-Poller protokollieren Fehlerfolge, periodische
  Zusammenfassungen und Recovery.
- Court-Stale richtet sich nach dem letzten erfolgreichen Poll.
- `/status` kann innerhalb einer noch gueltigen Adminsession kontrolliert auf
  eine Last-known-good-Rolle zurueckgreifen.
- Score- und Auditfachhistorien liegen getrennt in SQLite und sind nicht durch
  Loki zu ersetzen.
- PAJ besitzt persistentes journald mit dokumentiertem 1-GiB-Limit und 14 Tagen
  Maximalaufbewahrung sowie eine eigene systemd-Rate-Limit-Konfiguration.

### 3.2 Noch nicht vorhandene Komponenten

- Prometheus ist nicht installiert.
- Node Exporter ist nicht installiert.
- Grafana ist nicht installiert.
- Loki ist nicht installiert.
- Grafana Alloy ist nicht installiert.
- Das Backend stellt noch keinen `/metrics`-Endpoint bereit; ein Aufruf liefert
  aktuell 404.
- Caddy schreibt noch kein abgestimmtes Access-Log.
- Die in Frontendereignissen vorbereiteten Werte `frontend_normal=14` und
  `frontend_targeted=7` Tage sind noch keine technisch erzwungene Loki-Retention.

### 3.3 Zuletzt beobachteter Systemstand

- PAJ lief bereit mit dem zuletzt installierten Branchstand; `/ready` lieferte
  HTTP 200.
- Live lief auf dem vorangegangenen Main-Stand.
- PK war inaktiv und verwendete eine aeltere Unit-Konfiguration.
- Das PAJ-Journal belegte beim letzten Abgleich ungefaehr 56 MiB.
- Der Servicebenutzer `paj` hatte keinen vollstaendigen Zugriff auf alle
  systemweiten Journale.

Diese Beobachtungen sind keine dauerhaften Zusagen. Sie muessen vor der
Infrastrukturinstallation erneut erhoben und mit Datum dokumentiert werden.

### 3.4 Branch- und Abnahmekontext bei Planerstellung

- Aktueller Seitenbranch: `4.3.0-paj-1`.
- Basiscommit: `4bea205b2158f0f225a66d94bea6d93e647f4016`,
  `4.3.0-paj-1-7 | Scoreboard-Namensgroessen responsiv abgesichert`.
- Vorangegangener Loggingcommit:
  `2198cde7b3751c42b179beea10ce925dd734b5e9`,
  `4.3.0-paj-1-6 | Frontenddiagnose und Pollerresilienz erweitert`.
- Fuer diese Planerstellung wurde der uncommittierte Arbeitsstand
  `4.3.0-paj-1-7-x` mit Zielcommit `4.3.0-paj-1-8` vorbereitet.
- Der letzte vollstaendige Softwaretest vor der Planerstellung bestand aus
  `npm run build` mit 134 erfolgreichen Tests, einem erfolgreichen
  Chromium-Browsertest und `npm audit` ohne bekannte Schwachstellen.
- Chromium 150 und `playwright-core` 1.62.1 stehen fuer den separaten
  Scoreboard-Browserlayout-Test zur Verfuegung.
- Ungueltige einzelne Personen-E-Mails blockieren den Personenload nicht mehr;
  der Wert gilt fuer Login und Projektionen als leer und wird ohne Rohwert mit
  Personen-ID, Sheetzeile und Fehlergrund diagnostiziert. Beim letzten Abgleich
  war Sheetzeile 72 mit `personId: "71"` betroffen.
- Die Scoreboard-Namensgroessen sind fuer die dokumentierte Desktop- und
  Mobilmatrix responsiv abgesichert. Diese abgeschlossene Frontendarbeit gehoert
  nicht zum offenen Observability-Umfang.
- Push, Merge oder Rollout dieses neuen Arbeitsstands benoetigt einen gesonderten
  ausdruecklichen Auftrag.

## 4. Verbindliche Datenschutz- und Kardinalitaetsgrenzen

### 4.1 Niemals als Loki-Label

- Personen-ID
- Klarname
- E-Mail-Adresse oder maskierte E-Mail-Fragmente
- Quell-IP oder maskierte IP-Fragmente
- `supportId` beziehungsweise `requestId`
- WebSocket-Client-ID
- ephemere Seitensitzung
- Monitor- oder Geraetekennung
- URL mit freien Querywerten
- Browser-User-Agent in Rohform
- frei formulierter Fehlertext

Diese Werte duerfen, soweit bereits fachlich erlaubt und fuer Diagnose
erforderlich, ausschliesslich kontrollierte JSON-Felder sein. Ihre Sichtbarkeit
ist ueber Grafana-Rollen und Datenquellenzugriff zu begrenzen.

### 4.2 Vorgesehene niedrig-kardinale Loki-Labels

- System beziehungsweise Instanz: `paj`, `pk`, `live`
- Dienst beziehungsweise Quelle: Backend, Caddy oder definierter
  Infrastrukturservice
- Ereignisname aus serverseitiger Allowlist
- Level aus fester Menge
- serverseitig begrenzter Seitenname ohne Querywerte
- Serverversion
- Versionsuebereinstimmung aus fester Menge
- Diagnoseprofil beziehungsweise Retentionklasse aus fester Menge

Vor Aktivierung wird die tatsaechliche Labelmenge gegen Loki-Cardinality und
Speicherverbrauch getestet. Zusaetzliche Labels benoetigen eine begruendete
Freigabe.

### 4.3 Niemals erfassen

- Passwoerter, Passwort-Hashes oder Einmalcodes
- Session-, Monitor- oder sonstige Authentisierungstokens
- Cookies und Authorization-Header
- private Schluessel und Service-Account-Inhalte
- vollstaendige `.env`-Inhalte
- vollstaendige Request- oder Response-Bodies
- DOM-, Profil- oder Formulardumps
- vollstaendige Error-Objekte oder unkontrollierte Stacks aus dem Browser
- Telefonnummern, Geburtsdaten oder sonstige Profildaten ohne gesonderten
  unabweisbaren Betriebszweck

## 5. Paketuebersicht und Abhaengigkeiten

| Paket | Inhalt | Status | Abhaengigkeit |
|-------|--------|--------|----------------|
| 0 | Governance und Betreiberentscheidungen | BLOCKIERT | Entscheidung der Verantwortlichen |
| 1 | Zieltopologie und Kapazitaetsbasis | OFFEN | Paket 0 |
| 2 | Alloy- und Loki-Pipeline | OFFEN | Pakete 0 und 1 |
| 3 | Caddy-Access-Logging und Request-ID | OFFEN | Pakete 0 und 1 |
| 4 | Grafana-Logsuche und Zugriffsschutz | OFFEN | Pakete 2 und 3 |
| 5 | Backend-`/metrics` | OFFEN | Paket 0 |
| 6 | Prometheus und Node Exporter | OFFEN | Pakete 1 und 5 |
| 7 | Grafana-Dashboards | OFFEN | Pakete 4 und 6 |
| 8 | Alerting und Eskalation | OFFEN | Pakete 0, 6 und 7 |
| 9 | Praktische PAJ-Abnahme | OFFEN | Pakete 2 bis 8 |
| 10 | PK- und Live-Rollout | OFFEN | Paket 9 |
| 11 | Langfristige Daten-Governance | OFFEN | separate Freigabe |

## 6. Paket 0: Governance und Betreiberentscheidungen

### Ziel

Vor Installation zentraler Log- und Metrikdienste werden Verantwortlichkeiten,
Zugriff, Aufbewahrung, Speicherort und Eskalation verbindlich festgelegt.

### Offene Entscheidungen

- [ ] Technischer Betreiber fuer Grafana, Loki, Alloy und Prometheus benannt.
- [ ] Fachlich verantwortliche Person fuer personenbezogene Betriebsdaten
  benannt.
- [ ] Personen beziehungsweise Gruppen mit Grafana-Administrationsrecht benannt.
- [ ] Personen beziehungsweise Gruppen mit Zugriff auf personenbezogene
  Logfelder benannt.
- [ ] Reiner Dashboardzugriff ohne personenbezogene Logdetails als eigene Rolle
  festgelegt.
- [ ] Verfahren fuer Erteilung, regelmaessige Pruefung und Entzug von Zugriffen
  festgelegt.
- [ ] Verbindlicher Installationsort festgelegt: zentraler Host oder lokale
  Komponenten je ePiber-System.
- [ ] Festgelegt, ob PAJ, PK und Live in einem gemeinsamen Loki-Tenant oder
  getrennten Tenants beziehungsweise Instanzen liegen.
- [ ] Festgelegt, ob Grafana extern erreichbar ist oder nur ueber lokales Netz,
  VPN beziehungsweise administrativen Tunnel.
- [ ] Authentisierungsverfahren fuer Grafana festgelegt; anonyme Anmeldung bleibt
  deaktiviert.
- [ ] TLS- und Reverse-Proxy-Verantwortung fuer Grafana festgelegt.
- [ ] Backupbedarf fuer Grafana-Konfiguration, Dashboards und Loki-Daten
  festgelegt.
- [ ] Verbindliche Loki-Retention fuer normale Frontenddiagnose auf 14 Tage
  bestaetigt oder mit Begruendung geaendert.
- [ ] Verbindliche Loki-Retention fuer gezielte Frontenddiagnose auf 7 Tage
  bestaetigt oder mit Begruendung geaendert.
- [ ] Retention fuer Backendlogs, Caddy-Access-Logs und Infrastrukturjournale je
  Datenklasse festgelegt.
- [ ] Festgelegt, ob und wie eine vorzeitige gezielte Loeschung bei
  Datenschutzvorfaellen ausgefuehrt werden kann.
- [ ] Maximales Speicherbudget und Warnschwellen fuer Loki und Prometheus
  festgelegt.
- [ ] Alertempfaenger, Bereitschaftszeiten und Eskalationsweg festgelegt.
- [ ] Festgelegt, ob Grafana Alerting oder Prometheus mit Alertmanager die
  verbindliche Alarmierungsinstanz ist.
- [ ] Festgelegt, welche Alerts ausschliesslich aus Metriken entstehen und fuer
  welche Ausnahmefaelle eine Loki-basierte Regel erforderlich ist.
- [ ] Wartungsfenster und Regeln fuer Alert-Stummschaltung festgelegt.
- [ ] Verantwortliche Personen fuer PAJ-, PK- und Live-Abnahme benannt.
- [ ] Vier-Augen-Prinzip fuer produktive Konfigurationsaenderungen festgelegt.

### Entscheidungsbedarf Request-ID

Genau eine der folgenden Varianten ist auszuwaehlen und zu dokumentieren:

- [ ] Variante A: Caddy erzeugt eine Request-ID, das Backend uebernimmt sie nur
  von der bereits bestehenden Loopback-Vertrauensgrenze und verwendet sie fuer
  Header, Support-ID und Abschlusslog.
- [ ] Variante B: Das Backend bleibt alleiniger Erzeuger; Caddy uebernimmt die
  Backend-Response-`X-Request-ID` in sein Access-Log.

Eine unabgestimmte Mischform ist unzulaessig. Extern gelieferte Request-IDs
duerfen nicht ungeprueft zur serverseitigen Korrelation werden.

### Ergebnisartefakt

- Ein freigegebenes Betriebs- und Datenschutzentscheidungsprotokoll mit Datum,
  Verantwortlichen, gewaehlter Topologie, Rollenmatrix, Retentionwerten,
  Request-ID-Variante, Speicherbudget und Eskalationsweg.

### Abnahmekriterien

- [ ] Alle oben genannten Entscheidungen sind eindeutig beantwortet.
- [ ] Keine technische Folgeaufgabe benoetigt eine Vermutung zu Zugriff oder
  Datenschutz.
- [ ] Die freigegebenen Werte koennen direkt in versionierte Vorlagen und
  Abnahmetests uebersetzt werden.

## 7. Paket 1: Zieltopologie und Kapazitaetsbasis

### Ziel

Die konkrete Dienstverteilung, Netzgrenzen, Ports, Speicherpfade und
Kapazitaetsgrenzen werden vor der Installation entworfen und auf PAJ validiert.

### Aufgaben

- [ ] Aktuellen CPU-, RAM-, Dateisystem- und Journalverbrauch auf dem Zielhost
  ueber ein repraesentatives Zeitfenster erheben.
- [ ] Aktuelles Ereignisvolumen fuer Backend, Frontendcollector und Caddy unter
  Normalbetrieb und erwarteter Spitzenlast abschaetzen.
- [ ] Journald-Rate-Limit-Drops, Rotation und freien Speicher pruefen.
- [ ] Speicherbedarf aus Tagesvolumen, Retention, Replikation und Sicherheitsrand
  berechnen.
- [ ] Datenpfade fuer Loki, Prometheus und Grafana so festlegen, dass sie nicht
  unter statisch ausgelieferten Webroots liegen.
- [ ] Servicebenutzer und Dateirechte je Dienst festlegen.
- [ ] Lokale Ports und Firewallregeln dokumentieren; Metrik- und Adminports sind
  nicht unkontrolliert extern erreichbar.
- [ ] Systemd-Hardening fuer neue Dienste festlegen und mit den benoetigten
  Schreibpfaden abgleichen.
- [ ] Paketquellen, konkrete Paketversionen und Updateverfahren festlegen.
- [ ] Backup- und Restorebedarf fuer Grafana-Datenbank, Provisioningdateien,
  Prometheus-Regeln und gegebenenfalls Loki-Daten definieren.
- [ ] Rollbackpfad fuer jede neue systemd-Unit und Caddy-Aenderung beschreiben.
- [ ] Festlegen, wie `paj`, `pk` und `piber` Journale an Alloy lesbar werden,
  ohne den Anwendungsprozessen unnoetige Journalrechte zu geben.

### Vorgesehene versionierte Artefakte

- Alloy-Konfigurationsvorlage unter `Project/server-configs/`.
- Loki-Konfigurationsvorlage unter `Project/server-configs/`.
- Prometheus-Konfigurations- und Regelvorlage unter `Project/server-configs/`.
- Grafana-Provisioningvorlagen fuer Datenquellen und Dashboards unter
  `Project/server-configs/`.
- Systemd-Unit- oder Drop-in-Vorlagen fuer die neuen Dienste.
- Ergaenzung der Serverdokumentation erst nach ausdruecklich bestaetigtem
  Dokumentationsvorschlag.

### Abnahmekriterien

- [ ] Topologiediagramm nennt Host, Dienst, Port, Protokoll, Datenrichtung und
  Vertrauensgrenze.
- [ ] Kein neuer Dienstport ist unbeabsichtigt aus dem Internet erreichbar.
- [ ] Berechneter Speicherbedarf passt mit dokumentiertem Sicherheitsrand auf den
  Zielhost.
- [ ] Schreib- und Leserechte folgen dem Minimalprinzip.
- [ ] Installation und vollstaendige Deinstallation sind reproduzierbar.

## 8. Paket 2: Alloy- und Loki-Pipeline

### Ziel

Strukturierte journald-Ereignisse werden kontrolliert nach Loki transportiert,
korrekt geparst, sparsam gelabelt und entsprechend ihrer Datenklasse aufbewahrt.

### Alloy-Aufgaben

- [ ] Nur die benoetigten systemd-Units beziehungsweise `SyslogIdentifier`
  selektieren.
- [ ] Backend-JSON als JSON parsen; Parsefehler als technische Pipelinefehler
  sichtbar machen, ohne Rohgeheimnisse in Zusatzlogs zu duplizieren.
- [ ] Caddy-JSON separat parsen und auf eine kontrollierte Feldmenge reduzieren.
- [ ] Instanz, Dienst, Event, Level, Seite, Serverversion,
  Versionsuebereinstimmung und Diagnoseprofil nur nach Allowlist als Labels
  setzen.
- [ ] Personenbezogene und hoch-kardinale Felder explizit als JSON-Felder
  belassen.
- [ ] Nicht benoetigte journald-Metadaten verwerfen.
- [ ] Maximale Zeilengroesse und Verhalten bei Ueberschreitung festlegen.
- [ ] Queueing, Retry und Backoff bei nicht erreichbarem Loki konfigurieren.
- [ ] Begrenzungen fuer lokalen Puffer und Verhalten bei vollem Datentraeger
  festlegen.
- [ ] Alloy-eigene Metriken fuer erfolgreiche Sends, Fehler, Retries und Drops
  erfassbar machen.
- [ ] Konfiguration gegen absichtlich manipulierte beziehungsweise unvollstaendige
  JSON-Zeilen testen.

### Loki-Aufgaben

- [ ] Authentisierung beziehungsweise Netzabschottung entsprechend Paket 0
  umsetzen.
- [ ] Tenant- oder Instanztrennung entsprechend der Governance umsetzen.
- [ ] Schema, Indexspeicher, Chunkspeicher und Datenpfade explizit festlegen.
- [ ] Globale Retention und streambezogene Retention konfigurieren.
- [ ] `frontend_normal` technisch auf den freigegebenen Wert, vorbereitet 14
  Tage, begrenzen.
- [ ] `frontend_targeted` technisch auf den freigegebenen Wert, vorbereitet 7
  Tage, begrenzen.
- [ ] Retention fuer Backend-, Caddy- und Infrastrukturereignisse separat
  konfigurieren.
- [ ] Ingestion-, Query- und Streamlimits an Hostkapazitaet anpassen.
- [ ] Schutz gegen Label-Explosion und zu viele Streams konfigurieren.
- [ ] Loki-eigene Health- und Metrikendpunkte nur intern bereitstellen.
- [ ] Geplantes Backup- beziehungsweise Wiederanlaufverfahren praktisch testen.

### Pflichtproben

- [ ] Ein `http_request_completed` erreicht Loki mit korrekter Instanz, Event,
  Level und Serverversion.
- [ ] Ein `ws_request_completed` ist ueber die Support-ID als JSON-Feld suchbar.
- [ ] Ein `frontend_client_event` ist ueber Personen-ID, Name oder IP als
  JSON-Feld suchbar, ohne daraus einen eigenen Stream zu erzeugen.
- [ ] Normale und gezielte Frontendereignisse landen in unterscheidbaren
  Retentionklassen.
- [ ] Ein absichtlich unbekanntes Feld wird nicht automatisch zu einem Label.
- [ ] Ein absichtlich ungueltiges JSON-Ereignis blockiert die Pipeline nicht.
- [ ] Ein zeitweilig nicht erreichbares Loki fuehrt zu begrenzten Retries und
  anschliessender Recovery ohne unkontrolliertes lokales Wachstum.
- [ ] Definierte Drops werden messbar und alarmierbar.

### Abnahmekriterien

- [ ] End-to-End-Transport vom PAJ-Journal bis Loki ist reproduzierbar.
- [ ] Label-Cardinality bleibt in der erwarteten Groessenordnung.
- [ ] Personenbezogene Werte erscheinen nicht in Labels.
- [ ] Retention ist konfiguriert und durch eine kontrollierte kurze Testklasse
  beziehungsweise einen anderweitig belastbaren technischen Nachweis geprueft.
- [ ] Pipelineausfall beeintraechtigt den ePiber-Anwendungsprozess nicht.

## 9. Paket 3: Caddy-Access-Logging und Request-ID-Korrelation

### Ziel

Caddy liefert datensparsame Zugriffsdaten, die mit Backendabschluessen
korrelierbar sind, ohne Cookies, Tokens, freie Querydaten oder unkontrollierte
Clientheader zu speichern.

### Aufgaben

- [ ] Die in Paket 0 gewaehlte Request-ID-Variante implementieren.
- [ ] Strukturierte JSON-Ausgabe verwenden.
- [ ] Requestmethode, normalisierte Route, Status, Dauer, Antwortgroesse,
  Instanz und korrelierbare Request-ID aufnehmen.
- [ ] Querystrings entweder vollstaendig verwerfen oder auf eine ausdrueckliche
  harmlose Allowlist reduzieren.
- [ ] Request- und Response-Header standardmaessig nicht protokollieren.
- [ ] Cookies, Authorization, WebSocket-Protokollheader und sonstige Tokens
  explizit ausschliessen.
- [ ] Quell-IP nur entsprechend der freigegebenen Governance behandeln; sie
  bleibt bei zentraler Speicherung ein JSON-Feld und kein Label.
- [ ] User-Agent nur aufnehmen, wenn ein konkreter Betriebszweck und eine
  datensparsame Normalisierung beschlossen wurden.
- [ ] Health-, Ready- und Metrikabrufe gegebenenfalls sampeln oder getrennt
  behandeln, damit sie Nutzereignisse nicht ueberdecken.
- [ ] Caddy-Rotation beziehungsweise ausschliesslichen journald-Transport
  eindeutig festlegen; keine unbegrenzte zweite lokale Logkopie erzeugen.
- [ ] Caddy-Konfiguration vor Reload validieren.
- [ ] Reload und Rollback ohne Unterbrechung einer laufenden ePiber-Verbindung
  pruefen.

### Korrelationstest

- [ ] Einen erfolgreichen API-Request ausloesen.
- [ ] `X-Request-ID` im Browser beziehungsweise Testclient erfassen.
- [ ] Genau passenden Caddy-Zugriff ueber dieselbe ID finden.
- [ ] Genau passenden Backendabschluss ueber dieselbe ID finden.
- [ ] Route, Status und Zeitfenster zwischen beiden Quellen abgleichen.
- [ ] Einen kontrollierten 4xx- und einen kontrollierten 5xx-Fall entsprechend
  pruefen.
- [ ] Einen WebSocket-Upgrade separat pruefen; fachliche WS-Requests bleiben ueber
  ihre Backend-Support-ID korreliert.

### Abnahmekriterien

- [ ] Eine extern vorgegebene ID kann die vertrauenswuerdige serverseitige
  Korrelation nicht faelschen.
- [ ] Caddy- und Backendereignis sind fuer HTTP eindeutig verbunden.
- [ ] Keine Cookies, Tokens, Passwortwerte oder vollen Querystrings erscheinen in
  Caddy-Logs.
- [ ] Access-Log-Aufbewahrung entspricht der freigegebenen Retention.

## 10. Paket 4: Grafana-Logsuche und Zugriffsschutz

### Ziel

Grafana wird zur einzigen vorgesehenen zentralen Suchoberflaeche fuer
Betriebslogs. `adminLogging.html` bleibt ausschliesslich Konfiguration der
Frontenddiagnose.

### Aufgaben Zugriffsschutz

- [ ] Anonyme Anmeldung deaktivieren.
- [ ] Administrator-, Betreiber- und reine Dashboardrollen gemaess Paket 0
  anlegen.
- [ ] Zugriff auf Loki-Datenquellen mit personenbezogenen Feldern nur den
  berechtigten Rollen geben.
- [ ] Bearbeitung von Datenquellen, Retention und Dashboards auf Administratoren
  begrenzen.
- [ ] Session-, Passwort- und gegebenenfalls SSO-Regeln konfigurieren.
- [ ] Oeffentliche Dashboardfreigaben deaktivieren, sofern nicht gesondert
  geprueft und freigegeben.
- [ ] Export, Snapshot und Share-Funktionen auf Datenschutzfolgen pruefen.
- [ ] Grafana-Audit- beziehungsweise Zugriffsprotokollierung gemaess Governance
  konfigurieren.

### Aufgaben Logansichten

- [ ] Uebersicht nach Instanz, Dienst, Level und Ereignis anlegen.
- [ ] Suche nach `supportId` beziehungsweise `requestId` als JSON-Feld anbieten.
- [ ] Suche nach Personen-ID, Klarname und IP nur in einer geschuetzten
  Betreiberansicht anbieten.
- [ ] Ansicht fuer `frontend_client_event` mit Seite, Browserereignis,
  Diagnoseprofil, Serverversion und Versionsuebereinstimmung anlegen.
- [ ] Ansicht fuer HTTP-Fehler und langsame Requests anlegen.
- [ ] Ansicht fuer WebSocket-Abschluesse, Close-Codes und Reconnectfolgen anlegen.
- [ ] Ansicht fuer Sheet-/Court-Fehlerfolge, Suppression und Recovery anlegen.
- [ ] Ansicht fuer SQLite-, Server-Lifecycle- und Readinessfehler anlegen.
- [ ] Links zwischen Metrikpanel und gefilterter Logsuche vorbereiten.
- [ ] Standardzeitraeume und maximale Queryfenster so begrenzen, dass Loki nicht
  durch versehentliche Vollsuchen ueberlastet wird.

### Abnahmekriterien

- [ ] Eine autorisierte Person findet einen Testfehler ueber die sichtbare
  Support-ID bis zum Backendabschluss.
- [ ] Eine reine Dashboardrolle kann keine personenbezogenen Detailfelder
  abfragen.
- [ ] Unberechtigte beziehungsweise anonyme Zugriffe werden abgewiesen.
- [ ] Exportierte Screenshots und Testprotokolle verwenden nur synthetische oder
  redigierte Daten.
- [ ] Dashboard- und Datenquellenkonfiguration sind versioniert oder gesichert und
  reproduzierbar provisionierbar.

## 11. Paket 5: Backend-`/metrics`

### Ziel

Das Backend stellt eine kleine, stabile und nicht personenbezogene
Prometheus-Metrikmenge bereit. Metriken ersetzen keine Fachhistorie und enthalten
keine benutzer-, request- oder geraetespezifischen Labels.

### Zugriff und Format

- [ ] Endpoint nur ueber die festgelegte interne Vertrauensgrenze erreichbar
  machen.
- [ ] Kein anonymer externer Zugriff ueber den oeffentlichen Caddy-Origin, sofern
  nicht durch ein separates kontrolliertes Schutzkonzept erforderlich.
- [ ] Prometheus-Textformat mit korrektem Content-Type liefern.
- [ ] Scrape darf keine Google-Sheets-, Court- oder sonstigen externen Requests
  ausloesen.
- [ ] Scrape muss schnell, read-only und auch bei fachlicher Degradation
  erreichbar bleiben, solange der Prozess lebt.
- [ ] Metriknamen, Typ, Einheit und Bedeutung automatisiert testen und
  dokumentieren.

### Vorgesehene Metrikklassen

- [ ] Prozessstartzeit beziehungsweise Uptime.
- [ ] Aktuelle HTTP-Anzahl nach Methode, normalisierter Route und grober
  Statusklasse.
- [ ] HTTP-Dauer als bewusst begrenztes Histogramm nach normalisierter Route.
- [ ] Aktuelle WebSocket-Verbindungen nach niedrig-kardinalem Verbindungstyp.
- [ ] WebSocket-Requests und Abschluesse nach erlaubtem Operationstyp und
  Ergebnisgruppe.
- [ ] WebSocket-Close-Codes nach serverseitig begrenzter Codegruppe sowie
  Timeout- und Backpressurezaehler.
- [ ] Sheet-Poller letzter Erfolg, Alter, Fehlerfolge und Recoveryzaehler je
  definierter Tabelle.
- [ ] Court-Poller letzter Erfolg, Alter und Fehlerfolge je Instanz, nicht je
  Benutzer oder Match.
- [ ] Readinesszustand und grobe Readinessgruende aus fester Menge.
- [ ] SQLite-State, ScoreLog und Auditlog jeweils `ready/open`, Fehlerzaehler und
  kontrollierte Queue- beziehungsweise Pendingwerte.
- [ ] Frontendcollector angenommene, verworfene und rate-limitierte Ereignisse
  nach festem Grund und Diagnoseprofil.
- [ ] Backendlogger- beziehungsweise Transportdrops, soweit intern messbar.
- [ ] Event-Loop- oder Prozessressourcen nur, wenn sie stabil und ohne
  redundante Node-Exporter-Dopplung erhoben werden.

### Verbotene Metriklabels

- Benutzer-ID, Name, E-Mail, Rolle einer konkreten Person oder IP
- Support-, Request-, Session-, Socket-, Monitor-, Match- oder Court-ID mit
  unbeschraenkter Wertemenge
- rohe URL, Querystring oder Browserseite ohne serverseitige Begrenzung
- Fehlertext, Stack oder dynamischer Fehlercode ohne Allowlist
- App-Version des einzelnen Browserclients

### Automatisierte Tests

- [ ] Endpointzugriff und Zugriffsschutz.
- [ ] Content-Type und syntaktisch gueltiges Prometheusformat.
- [ ] Vorhandensein aller vereinbarten Metriken.
- [ ] Korrekte Countererhoehung fuer Erfolg und kontrollierten Fehler.
- [ ] Korrekte Gaugeaenderung fuer Pollerstale, Readiness und Recovery.
- [ ] Begrenzte Routennamen und Fehlergruende.
- [ ] Keine personenbezogenen oder hoch-kardinalen Labels in Testausgabe.
- [ ] Scrape veraendert keinen Fachzustand.

### Abnahmekriterien

- [ ] Prometheus kann den Endpoint stabil scrapen.
- [ ] Die Metrikmenge beantwortet die geplanten Dashboard- und Alertfragen.
- [ ] Serienanzahl bleibt bei steigender Benutzer- und Requestzahl begrenzt.
- [ ] Der Endpoint enthaelt keine geheimen oder personenbezogenen Werte.

## 12. Paket 6: Prometheus und Node Exporter

### Ziel

Anwendungs- und Hostmetriken werden mit kontrollierter Aufbewahrung gesammelt,
ohne neue ungeschuetzte Verwaltungsoberflaechen zu schaffen.

### Prometheus-Aufgaben

- [ ] Scrapeziele fuer PAJ-Backend, Node Exporter, Loki und Alloy konfigurieren.
- [ ] Spaetere PK-/Live-Ziele bereits strukturell vorbereiten, aber vor deren
  Freigabe nicht als erfolgreich voraussetzen.
- [ ] Scrapeintervalle passend zu Pollerintervallen und Alertreaktionszeit
  festlegen.
- [ ] Scrape-Timeouts kleiner als Intervalle konfigurieren.
- [ ] Externe Labels fuer Instanz und Umgebung niedrig-kardinal halten.
- [ ] TSDB-Datenpfad und Retention nach Paket 0 konfigurieren.
- [ ] Maximale Datentraegerbelegung und Warnschwellen festlegen.
- [ ] Konfigurationsreload und Fehlerfall testen.
- [ ] Prometheus-Weboberflaeche und Admin-API nicht unkontrolliert extern
  erreichbar machen.
- [ ] Regeldateien versioniert und mit `promtool` pruefbar halten.

### Node-Exporter-Aufgaben

- [ ] Nur benoetigte Collectors aktivieren.
- [ ] CPU, RAM, Load, Dateisystem, Inodes, Netzwerk und systemd-relevante
  Grunddaten erfassen.
- [ ] Pseudo-, Container-, Temporaer- und irrelevante Dateisysteme ausschliessen.
- [ ] Besonders die Datenpfade fuer journald, SQLite, Loki und Prometheus
  beobachtbar machen.
- [ ] Keine Textfile-Collector-Dateien mit Geheimnissen oder personenbezogenen
  Werten zulassen.
- [ ] Listener nur an der festgelegten internen Schnittstelle bereitstellen.

### Abnahmekriterien

- [ ] Alle erwarteten Targets sind `UP` oder ein absichtlich inaktives
  Rolloutziel ist eindeutig deaktiviert.
- [ ] Scrapeausfall wird als Metrik sichtbar.
- [ ] Hostmetriken zeigen plausible Werte im Vergleich zu lokalen Systemtools.
- [ ] TSDB-Wachstum entspricht der Kapazitaetsplanung.
- [ ] Neustart und Konfigurationsreload verlieren keine unvertretbare Datenmenge
  und beeintraechtigen ePiber nicht.

## 13. Paket 7: Grafana-Dashboards

### Ziel

Dashboards beantworten konkrete Betriebsfragen, ohne personenbezogene Details in
Uebersichten zu zeigen.

### Dashboard A: Systemuebersicht

- [ ] Erreichbarkeit und Scrapezustand je Instanz.
- [ ] `/live`- und Readinesszustand.
- [ ] Serverversion je Instanz und erkennbare Versionsabweichung.
- [ ] HTTP-Rate, Statusklassen und Latenzquantile.
- [ ] Aktuelle WebSocket-Verbindungen und Requestergebnisse.
- [ ] Letzte Sheet- und Court-Erfolge sowie Fehlerfolgen.
- [ ] SQLite-State, ScoreLog und Auditlog grob gesund beziehungsweise ungesund.

### Dashboard B: Ressourcen und Kapazitaet

- [ ] CPU, Load und RAM.
- [ ] Freier Speicher und Inodes fuer Journal-, SQLite-, Loki- und
  Prometheuspfade.
- [ ] journald-, Loki- und Prometheus-Wachstum, soweit verlaesslich messbar.
- [ ] Netzwerkdurchsatz und Fehler.
- [ ] Prozessneustarts und Uptime.

### Dashboard C: Loggingpipeline

- [ ] Alloy-Sendrate, Retries, Parsefehler und Drops.
- [ ] Loki-Ingestion, Queryfehler, aktive Streams und Cardinality-Indikatoren.
- [ ] Frontendcollector angenommen, verworfen und rate-limitiert.
- [ ] Verteilung normaler und gezielter Diagnoseprofile.
- [ ] Caddy- und Backendereignisvolumen nach fester Ereignisklasse.

### Dashboard D: Fehler und Recovery

- [ ] HTTP-5xx-Rate und langsamste normalisierte Routen.
- [ ] WebSocket-Fehlergruppen und Close-Codes.
- [ ] Sheet-/Court-Fehlerfolgen und Ausfalldauer.
- [ ] Readinessgruende und Recoveryzeit.
- [ ] SQLite-Fehler und Pendingwerte.
- [ ] Direkte Links in die passend gefilterte Logansicht.

### Abnahmekriterien

- [ ] Jedes Panel hat Titel, Einheit, Datenquelle und beschriebene Aussage.
- [ ] Keine personenbezogenen Felder erscheinen in Standarddashboards.
- [ ] Leer-, Stale- und No-data-Zustaende sind von gesundem Nullwert
  unterscheidbar.
- [ ] PAJ-, PK- und Live-Filter sind eindeutig und koennen nicht versehentlich
  vermischt interpretiert werden.
- [ ] Dashboarddefinitionen sind reproduzierbar provisioniert oder versioniert.
- [ ] Panels funktionieren fuer kurze Stoerung, laengeren Ausfall und Recovery.

## 14. Paket 8: Alerting und Eskalation

### Ziel

Alerts melden handlungsrelevante Zustaende mit angemessener Verzoegerung und
vermeiden personenbezogene Inhalte sowie Alarmfluten.

### Vorgesehene Alerts

- [ ] Backendtarget oder Instanz nicht erreichbar.
- [ ] `/live` fehlerhaft beziehungsweise Prozess wiederholt neu gestartet.
- [ ] Readiness ueber die vereinbarte Toleranz hinaus rot.
- [ ] Sheet-Poller letzter Erfolg zu alt oder Fehlerfolge zu hoch.
- [ ] Court-Poller letzter Erfolg zu alt oder Fehlerfolge zu hoch.
- [ ] ScoreLog oder Auditlog nicht bereit beziehungsweise wiederholte
  Schreibfehler.
- [ ] Unerwartete Pending-Metadata-Intents.
- [ ] HTTP-5xx-Rate oder Latenz ueber freigegebener Schwelle.
- [ ] Unerwarteter WebSocket-Fehler- oder Reconnectanstieg.
- [ ] Alloy-Drops, anhaltende Sendefehler oder Loki-Ingestionfehler.
- [ ] Prometheus-Scrapeausfall.
- [ ] Freier Speicher oder Inodes unter Warn- beziehungsweise Kritischschwelle.
- [ ] RAM-, Load- oder Prozessressource ueber nachhaltiger Schwelle.
- [ ] Loki- beziehungsweise Prometheusdaten wachsen schneller als geplant.
- [ ] Frontendcollector verwirft ungewoehnlich viele Ereignisse durch Rate-Limit
  oder Validierung.

### Regelanforderungen

- [ ] Jeder Alert besitzt `warning` oder `critical`, Kurzbeschreibung,
  betroffene Instanz, Runbook-Link und verantwortliche Empfaengergruppe.
- [ ] Alerttexte enthalten keine Namen, IDs, IPs, Support-IDs oder freien
  Fehlertexte.
- [ ] `for`-Zeitraeume verhindern Flattern bei kurzen erwarteten Uebergaengen.
- [ ] Abhaengigkeiten werden beruecksichtigt, damit ein Hostausfall nicht eine
  unkontrollierte Folge redundanter Kindalarme erzeugt.
- [ ] Wartungsfenster und geplante Deployments koennen nachvollziehbar stumm
  geschaltet werden.
- [ ] Recovery erzeugt eine aufloesende Meldung.
- [ ] Jede Regel besitzt einen synthetischen oder kontrollierten praktischen
  Ausloesetest.

### Abnahmekriterien

- [ ] Warn- und Kritischpfad erreichen die vereinbarten Empfaenger.
- [ ] Testalerts enthalten alle noetigen Handlungsinformationen und keine
  personenbezogenen Daten.
- [ ] Ein kontrollierter Ausfall erzeugt genau die erwartete Alarmgruppe.
- [ ] Recovery beendet den Alarm ohne manuellen Datenbankeingriff.
- [ ] Runbooks nennen Diagnose, sichere Erstreaktion, Eskalation und Rollback.

## 15. Paket 9: Praktische PAJ-Abnahme

### Ziel

Automatisierte Tests und Konfigurationspruefungen werden durch reale
End-to-End-, Last-, Ausfall-, Datenschutz- und Rollbackproben auf PAJ ergaenzt.

Die vollstaendige allgemeine Abnahme bleibt in
`Project/server-configs/ROLLOUT-CHECKLIST.md`. Dieses Paket konkretisiert nur die
Logging- und Observability-Ergaenzungen.

### Vorbedingungen

- [ ] Alle Pakete 0 bis 8 sind technisch umgesetzt.
- [ ] Konfigurationen wurden statisch validiert.
- [ ] Backup und dokumentierter Rollbackpunkt existieren.
- [ ] Testfenster, Testpersonen und verantwortliche zweite pruefende Person sind
  festgelegt.
- [ ] Es werden nur freigegebene Testidentitaeten und keine unnoetigen echten
  personenbezogenen Daten verwendet.

### Basispruefung

- [ ] Alle neuen systemd-Dienste laufen mit erwarteten Benutzern und Rechten.
- [ ] Caddy, Backend, Alloy, Loki, Prometheus, Node Exporter und Grafana melden
  plausible Healthzustaende.
- [ ] `/version`, `/live`, `/ready` und `/health` liefern erwartete Werte.
- [ ] Prometheusziele sind gruen.
- [ ] Grafana-Datenquellen sind erreichbar.
- [ ] Journald-Rotation, Retention und Rate-Limits entsprechen der Vorlage.
- [ ] Keine neue Verwaltungsoberflaeche oder Metrikschnittstelle ist
  unbeabsichtigt extern erreichbar.

### End-to-End-Korrelation

- [ ] Erfolgreichen HTTP-Aufruf ueber Browser oder Testclient ausloesen.
- [ ] Request-ID in Caddy, Backend und Grafana identisch nachweisen.
- [ ] Kontrollierten 4xx-Fehler ausloesen und ueber Support-ID finden.
- [ ] Kontrollierten 5xx-Test nur mit sicherem, reversiblen Verfahren ausloesen
  und anschliessend Recovery nachweisen.
- [ ] WebSocket-Auftrag und Abschluss ueber serverseitige Support-ID finden.
- [ ] Browserdiagnose mit freigegebenem technischen Testereignis ausloesen und
  bis Loki verfolgen.

### Frontenddiagnose

- [ ] Globale Policy verteilen und Wirkung im Collector pruefen.
- [ ] Anonyme Diagnose deaktivieren und nachweisen, dass anonyme Events nicht
  zentral angenommen werden.
- [ ] Temporaere Zielperson setzen und korrekten neutralen Benutzerhinweis
  pruefen.
- [ ] Serveranreicherung von Test-Personen-ID, Name, Rolle und IP nachweisen.
- [ ] Nach Ablauf Rueckfall auf globale Policy nachweisen.
- [ ] Zielpersonen-Retentionklasse und normale Retentionklasse unterscheiden.
- [ ] Collector-Rate-Limit kontrolliert ausloesen, ohne Logsturm zu erzeugen.
- [ ] Suche nach ID, Name und IP nur mit berechtigter Betreiberrolle pruefen.
- [ ] Mit reiner Dashboardrolle bestaetigen, dass diese Details nicht zugaenglich
  sind.

### Poller und Recovery

- [ ] Kontrollierten Sheet-Ausfall ausloesen.
- [ ] Erstfehler, Fehlerfolge, periodische Suppression und Recovery in Logs
  nachweisen.
- [ ] Metrik und Dashboardzustand waehrend Fehler und Recovery pruefen.
- [ ] Alert nach Toleranzfenster und Aufloesung nach Recovery pruefen.
- [ ] Dasselbe fuer Court-Poller mit realen Pollintervallen pruefen.
- [ ] Readiness-Uebergaenge gegen den dokumentierten Fachvertrag pruefen.
- [ ] `/status` mit gueltiger Adminsession bei stale Personenquelle und nach
  Sessionablauf pruefen.

### Ressourcen, Last und Dauerbetrieb

- [ ] Erwartete Spitzenlast mit Frontenddiagnose, HTTP und WebSocket realistisch
  erzeugen.
- [ ] Doppeltes erwartetes Spitzenvolumen fuer das vereinbarte Zeitfenster
  pruefen.
- [ ] Loki-Streamanzahl, Alloy-Puffer, Prometheus-Serien, CPU, RAM und
  Datentraegerwachstum beobachten.
- [ ] Sicherstellen, dass Logging und Scrapes den Anwendungsprozess nicht
  destabilisieren.
- [ ] Journald-Drops und Alloy-Drops pruefen; jeder Drop muss sichtbar sein.
- [ ] Einen kompletten repraesentativen Veranstaltungstag beziehungsweise das
  vereinbarte Dauerbetriebsfenster beobachten.
- [ ] Kapazitaetsprognose mit den real gemessenen Werten aktualisieren.

### Ausfall- und Recoveryproben

- [ ] Loki stoppen: ePiber bleibt funktionsfaehig, Alloy puffert begrenzt und
  meldet Fehler.
- [ ] Loki wieder starten: Pipeline erholt sich kontrolliert.
- [ ] Prometheus stoppen: ePiber bleibt funktionsfaehig; nach Neustart werden
  Targets wieder gruen.
- [ ] Grafana stoppen: Datenerfassung laeuft weiter.
- [ ] Datentraegerwarnschwelle kontrolliert simulieren und Alert pruefen.
- [ ] SIGTERM-Drain des ePiber-Backends bei laufenden Scrapes und Logtransport
  pruefen.
- [ ] Neustart aller Observability-Dienste in dokumentierter Reihenfolge pruefen.

### Datenschutzproben

- [ ] Loki-Labels auf verbotene personenbezogene oder hoch-kardinale Werte
  untersuchen.
- [ ] Caddy-Logs auf Cookies, Authorization, Tokens und Querystrings untersuchen.
- [ ] Frontendlogs auf Payloads, DOM-/Profildaten, Stacks, E-Mail, Telefon,
  Passwortwerte und Tokens untersuchen.
- [ ] Grafana-Rollen mit positivem und negativem Zugriffstest pruefen.
- [ ] Exporte, Screenshots und Alerttexte auf personenbezogene Werte pruefen.
- [ ] Retention beziehungsweise kontrollierte Testloeschung technisch
  nachweisen.

### Rollbackprobe

- [ ] Vorherige Caddy- und systemd-Konfiguration sichern.
- [ ] Neue Observability-Komponenten kontrolliert deaktivieren beziehungsweise
  auf vorherigen Stand zuruecksetzen.
- [ ] Nachweisen, dass ePiber danach weiterhin `/live` und `/ready` liefert.
- [ ] Caddy-Rollback ohne Verlust der bestehenden HTTPS-/WSS-Funktion pruefen.
- [ ] Danach den freigegebenen Observability-Stand erneut reproduzierbar
  installieren.
- [ ] Dauer, Schritte, Datenverlustfenster und verantwortliche Personen
  protokollieren.

### PAJ-Gate

- [ ] Alle automatisierten Tests sind gruen.
- [ ] Alle praktischen Punkte dieses Pakets sind bestanden.
- [ ] Keine offenen kritischen oder hohen Fehler.
- [ ] Keine ungeklaerte Label-Cardinality, kein unkontrolliertes Wachstum und
  keine unbeabsichtigte Datenoffenlegung.
- [ ] Verantwortliche und zweite pruefende Person haben die PAJ-Abnahme
  protokolliert.

## 16. Paket 10: PK- und Live-Rollout

### Grundregel

PK und Live erhalten exakt denselben freigegebenen Release-Commit, Lockfile-Hash
und versionierten Infrastrukturstand wie PAJ. Lokale Geheimnisse und
systemspezifische IDs bleiben getrennt.

### PK

- [ ] PK-Unit, Pfade, Benutzer, Ports und lokale Konfiguration vor Installation
  gegen den aktuellen Sollstand angleichen.
- [ ] Eigenes Backup und eigener Rollbackpunkt vorhanden.
- [ ] Observability-Konfiguration mit Instanzlabel `pk` installieren.
- [ ] Keine PAJ- oder Live-Credentials beziehungsweise Datenquellen verwenden.
- [ ] Health, Scrapes, Logs, Dashboards und Testalert pruefen.
- [ ] Einen kontrollierten HTTP-, WebSocket-, Frontenddiagnose- und
  Poller-Smoke-Test ausfuehren.
- [ ] Zugriffsschutz und Nicht-Erreichbarkeit interner Ports pruefen.
- [ ] Vereinbartes Beobachtungsfenster ohne neue kritische oder hohe Fehler
  absolvieren.
- [ ] PK-Freigabe durch verantwortliche und zweite pruefende Person
  protokollieren.

### Live

- [ ] Wartungsfenster und Kommunikationsweg bestaetigen.
- [ ] Live-Backup und Rollbackpunkt unmittelbar vor Deployment aktualisieren.
- [ ] Exakt freigegebenen Commit, Lockfile-Hash und Vorlagenstand installieren.
- [ ] Live-spezifische Pfade, Ports, Instanzlabels und Credentials im
  Vier-Augen-Prinzip pruefen.
- [ ] Health, Scrapes, Loki-Ingestion, Grafana-Dashboards und Alerttransport
  pruefen.
- [ ] Request-ID-Korrelation mit einem risikoarmen Read testen.
- [ ] Frontendcollector ohne personenbezogenen Teststurm pruefen.
- [ ] Keine riskanten Fachwrites nur fuer Observability ausloesen.
- [ ] Ressourcen, Fehler, Reconnects und Poller waehrend des vereinbarten
  Nachbeobachtungsfensters aktiv ueberwachen.
- [ ] Bei Gateverletzung nach dem geprueften Verfahren zurueckrollen.

### Rollout-Abnahmekriterien

- [ ] PAJ, PK und Live zeigen eindeutig getrennte Instanzdaten.
- [ ] Keine Daten oder Credentials wurden zwischen Systemen verwechselt.
- [ ] Alle drei Systeme verwenden denselben freigegebenen Software- und
  Vorlagenstand.
- [ ] Interne Observability-Ports sind nicht unkontrolliert extern erreichbar.
- [ ] Retention, Rollen und Alerts wirken auf allen Zielsystemen wie beschlossen.
- [ ] Nachbeobachtungsfenster ist ohne offene kritische oder hohe Fehler
  abgeschlossen.

## 17. Paket 11: Langfristige Daten-Governance

Dieses Paket ist fachlich verwandt, aber nicht Voraussetzung fuer die erste
zentrale Observability-Inbetriebnahme, sofern Paket 0 die aktuelle Behandlung
ausdruecklich freigibt. Es benoetigt jeweils einen eigenen Analyse- und
Umsetzungsauftrag.

### Auditloeschung und Anonymisierung

- [ ] Rechts- und Betriebsanforderungen fuer personenbezogene Auditdaten klaeren.
- [ ] Aufbewahrungsfrist je Auditaktion festlegen.
- [ ] Loeschung oder Anonymisierung so entwerfen, dass Eventkonsistenz erhalten
  bleibt.
- [ ] SQLite-Hauptdateien, WAL/SHM, Onlinebackups und vorhandene Sicherungen
  gemeinsam behandeln.
- [ ] Vorschau, Vier-Augen-Freigabe, Ausfuehrungsnachweis und Recovery vorsehen.
- [ ] Keine allgemeine Massenloeschung ohne gesicherten Scope zulassen.

### Manipulationsnachweis

- [ ] Bedrohungsmodell fuer Audit- und Scorehistorien festlegen.
- [ ] Geeignetes Verfahren wie Hashverkettung oder signierte externe
  Checkpoints bewerten.
- [ ] Schluesselverwaltung, Rotation, Backup und Verifikation entwerfen.
- [ ] Verhalten bei Luecke, Restore und legitimer Datenbereinigung definieren.
- [ ] Performance- und Betriebsfolgen auf PAJ pruefen.

### Historische Sheet-Tabs

- [ ] `Logging` und `ScoreLog` als historische Quellen inventarisieren.
- [ ] Vollstaendige geschuetzte Archivkopie erstellen.
- [ ] Zugriff und Aufbewahrung des Archivs festlegen.
- [ ] Festhalten, dass kein automatischer Import in die SQLite-Systeme erfolgt.
- [ ] Optionale Entfernung aus aktiven Sheets erst nach bestaetigter Archivierung
  und Vier-Augen-Pruefung durchfuehren.

## 18. Paketuebergreifende Teststrategie

### Statische Pruefungen

- [ ] Node-Checks und gesamte automatisierte Testsuite.
- [ ] Prometheusformat und Metriknamenskonventionen.
- [ ] `promtool check config` und `promtool check rules`.
- [ ] Loki- und Alloy-Konfigurationsvalidierung mit der eingesetzten Version.
- [ ] Grafana-Provisioning beziehungsweise Dashboard-JSON validieren.
- [ ] `caddy validate` vor jedem Reload.
- [ ] `systemd-analyze verify` fuer neue oder geaenderte Units.
- [ ] `git diff --check`.

### Automatisierte Integrationstests

- [ ] `/metrics`-Zugriff, Format, Werte und Kardinalitaetsgrenzen.
- [ ] Request-ID-Uebernahme beziehungsweise Response-Korrelation entsprechend der
  gewaehlten Variante.
- [ ] Redaction und Ausschluss verbotener Caddy-Felder soweit automatisierbar.
- [ ] Beispielereignisse durch Alloy-Pipeline mit erwarteten Labels und Feldern.
- [ ] Frontend-Retentionklasse normal und gezielt.
- [ ] Alertregeln mit synthetischen Zeitreihen.
- [ ] Dashboardqueries gegen kontrollierte Testdaten.

### Praktische Tests

- [ ] Positive und negative Rollenpruefung.
- [ ] Korrelation HTTP, WebSocket und Frontenddiagnose.
- [ ] Ausfall, Suppression und Recovery.
- [ ] Retention und Loeschung.
- [ ] Last, Dauerbetrieb und Datentraegerwachstum.
- [ ] Dienstneustart, SIGTERM und Rollback.

## 19. Sicherheits- und Betriebsreview vor jeder Promotion

- [ ] Keine Secrets in versionierten Dateien oder generierten Artefakten.
- [ ] Keine Secrets oder personenbezogenen Werte in Testausgaben, Screenshots
  oder Tickets.
- [ ] Alle Listener, Firewallregeln und Caddy-Routen geprueft.
- [ ] Servicebenutzer ohne unnoetige Login-, Shell- oder Schreibrechte.
- [ ] Datenpfade nicht unter `Frontend/` oder anderen statischen Webroots.
- [ ] Grafana ohne anonymen Zugriff.
- [ ] Loki, Prometheus, Alloy und Node Exporter nicht unkontrolliert extern
  erreichbar.
- [ ] Personenbezogene Felder nicht als Loki-Labels oder Prometheus-Labels.
- [ ] Aufbewahrung technisch aktiv, nicht nur dokumentiert.
- [ ] Speicherwarnungen greifen deutlich vor vollem Dateisystem.
- [ ] Backup und Restore beziehungsweise bewusster Verzicht je Komponente
  dokumentiert.
- [ ] Rollback wurde auf PAJ praktisch bewiesen.

## 20. Definition of Done fuer den Gesamtplan

Der Logging- und Observability-Restumfang ist erst abgeschlossen, wenn:

- [ ] Governance, Rollen, Topologie, Retention und Eskalation freigegeben sind;
- [ ] Alloy und Loki strukturierte Logs aller freigegebenen Quellen sicher
  transportieren und speichern;
- [ ] normale und gezielte Frontenddiagnose nachweislich unterschiedliche,
  technisch erzwungene Retention besitzt;
- [ ] Caddy-Zugriffe datensparsam und eindeutig mit Backendrequests korrelierbar
  sind;
- [ ] Grafana geschuetzte Logsuche und nicht personenbezogene Standarddashboards
  bereitstellt;
- [ ] das Backend eine kleine stabile und nicht personenbezogene Metrikmenge
  liefert;
- [ ] Prometheus und Node Exporter Anwendung und Host verlaesslich beobachten;
- [ ] alle vereinbarten Warn- und Kritischalerts praktisch ausgeloest und
  aufgeloest wurden;
- [ ] Last, Pipelineausfall, Retention, Datenschutz, SIGTERM und Rollback auf PAJ
  bestanden sind;
- [ ] PK und Live denselben freigegebenen Stand durch die vorgesehenen Gates
  erhalten haben;
- [ ] keine offenen kritischen oder hohen Fehler und keine ungeklaerten
  Datenschutz- oder Kapazitaetsrisiken verbleiben;
- [ ] permanente Software- und Betriebsdokumentation nach dem freigegebenen
  Dokumentationsworkflow aktualisiert wurde;
- [ ] Ergebnis- und Freigabeprotokolle keine Geheimnisse oder unnoetigen
  personenbezogenen Werte enthalten.

## 21. Naechster konkreter Schritt

Als naechstes ist ausschliesslich Paket 0 abzuarbeiten. Ohne die dortigen
Entscheidungen werden weder Loki/Grafana/Alloy installiert noch Caddy-Logging,
Metriken oder Alerts implementiert. Das Ergebnis von Paket 0 bestimmt die
konkreten Vorlagen und Installationsschritte der Pakete 1 bis 8.

## 22. Quellen und Abgrenzung

Dieser Plan konsolidiert den zum Erstellungszeitpunkt bekannten Stand aus:

- `Project/2do/LOGGING-RESTPAKETE-OFFEN.md`
- `Project/2do/LOGGING-RESTPAKETE-1-BIS-3-UMGESETZT.md`
- `Project/2do/LOGGING-ANALYSE-AKTUALISIERT.md`
- `Project/2do/LOGGING-UMSETZUNGSPLAN.md`
- `Project/server-configs/ROLLOUT-CHECKLIST.md`
- `Project/server-configs/SERVER-SETUP.txt`
- `Project/software/ARCHITEKTUR.txt`
- `Project/software/ENDPOINTS.txt`
- `Project/software/seiten/adminLogging.txt`

Bei Widerspruechen zum Laufzeitverhalten gilt der aktuelle Code. Bei
Widerspruechen zur permanenten Dokumentation ist die Abweichung vor der
Implementierung aufzuklaeren. Lokale Geheimnisdateien und
Service-Account-Schluessel sind keine Quellen dieses Plans und duerfen fuer seine
Abarbeitung nicht ungezielt gelesen oder ausgegeben werden.
