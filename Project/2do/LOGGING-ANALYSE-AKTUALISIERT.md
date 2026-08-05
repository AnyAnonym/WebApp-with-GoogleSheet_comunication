# Aktualisierte Analyse von Logging und Observability

Stand: 03.08.2026
Verglichener Stand: Implementierungsstatus v4.1.0 bis Main v4.3.0

## Kurzuebersicht: Wo Logs und Diagnosen zu finden sind

### Aktuell

- Backend-Logs: `journalctl -u epiber-{paj|pk|piber}`
- Caddy-Meldungen: `journalctl -u caddy`
- Frontend-Fehler: Browser-DevTools
- Live-Diagnose: admin-geschuetztes `/status`
- Fachlogs: Google Sheets `ScoreLog` und `Logging`
- Kein Caddy-Access-Log, zentrales Dashboard oder Metriksystem vorhanden

### Empfohlenes Zielsetup

- Strukturierte Backend- und Caddy-Logs zentral sammeln, etwa aus journald
- Grafana fuer Metriken, Datenalter, Fehlerquoten und Alarmierung
- Loki fuer durchsuchbare Logeintraege, passend zu Grafana
- Audit- und Scoreereignisse dauerhaft in SQLite beziehungsweise einem geschuetzten Audit-Speicher
- `/status` weiterhin fuer kurzfristige Detaildiagnosen

Damit waere Grafana die zentrale Ueberwachungsoberflaeche, Loki die Logsuche und
`/status` die technische Detailansicht.

## Empfohlener Aufbau des Zielsetups

1. Auf jedem System journald persistent und mit festen Groessen- und
   Aufbewahrungsgrenzen konfigurieren. Backend und Caddy schreiben weiterhin in
   das lokale Journal, damit Diagnosen auch bei Ausfall der zentralen Sammlung
   kurzfristig verfuegbar bleiben.
2. Grafana Alloy oder einen vergleichbaren Agenten auf jedem System einsetzen.
   Der Agent liest die Journale der jeweiligen ePiber-Unit und von Caddy, versieht
   sie mit System-, Service- und Umgebungslabels und sendet sie an Loki.
3. Das Backend auf strukturierte JSON-Logs umstellen und Caddy-Access-Logs nach
   der Datenschutzfestlegung aktivieren. Cookies, Authorization-Header,
   personenbezogene Queryparameter und nicht benoetigte IP-Daten werden nicht
   uebertragen.
4. Prometheus fuer technische Metriken einsetzen. Dazu gehoeren mindestens
   Backend-Requestzahlen und -latenzen, Pollerfehler, Datenalter, Courtstatus,
   WebSocket-Verbindungen, Queuezustaende sowie Hostmetriken eines Node Exporters.
5. Grafana mit Loki und Prometheus verbinden. Dashboards zeigen Servicezustand,
   Fehlerquote, Datenalter, WebSocket-Zustaende und Ressourcen; aus einem
   Metrikereignis soll direkt zu den korrelierten Loki-Logs gesprungen werden
   koennen.
6. Alarmierung ueber Grafana Alerting oder Alertmanager einrichten. Wesentliche
   Alarme sind fehlende Readiness, veraltete Sheet- oder Courtdaten, wiederholte
   Pollerfehler, wachsende Score-/Auditqueues, Backend-Neustartschleifen und
   knapper Speicherplatz.
7. Score- und Auditereignisse nicht nur als Betriebslogs behandeln. Sie werden
   mit Event-ID und Correlation-ID dauerhaft und gesichert gespeichert,
   regelmaessig gesichert und nur fuer berechtigte Rollen zugaenglich gemacht.
8. `/status` bleibt die geschuetzte Detailansicht fuer eine einzelne laufende
   Instanz. Es ersetzt weder Loki noch Prometheus und sollte nicht automatisiert
   als dauerhaftes Logarchiv gespeichert werden.

## Ausfuehrliche aktualisierte Analyse (unveraenderter Wortlaut)

**Aktualisierter Befund**
Die ursprüngliche Analyse betrachtet v3.0.2 und enthält einen Nachtrag bis v4.1.0. Seitdem wurden bis Main v4.3.0 folgende relevante Verbesserungen umgesetzt:

- `/live`, `/ready` und `/health` besitzen belastbare Statuscodes; `/status` ist admin-geschützt und `no-store` (`Backend/server.js:139`).
- Kontrollierter Shutdown, Signalbehandlung und Request-/Sheets-Drain sind vorhanden (`Backend/server.js:359`).
- Öffentliche Personenprojektionen wurden minimiert; Passwortdaten werden nicht mehr allgemein ausgeliefert (`Backend/authService.js:102`).
- HTTP- und WebSocket-Fehler erhalten Support-IDs.
- WebSocket-Close-Code, App-Version, Client-/Seitentyp und weitere Diagnosewerte stehen in `/status`.
- Der Versionskonflikt 4406 wird kontrolliert behandelt.
- Legacy-Court-Migrationen sind diagnostizierbar und beeinflussen Readiness korrekt (`Backend/stateStore.js:37`, `Backend/server.js:60`).
- Ein Journald-Beobachtungsablauf und zusätzliche Rolloutprüfungen wurden dokumentiert.

Seit v4.1.0 nicht umgesetzt wurden dagegen:

- zentraler strukturierter Logger und Loglevel,
- Caddy-Access-Logging,
- Metrikexport und Alarmierung,
- zuverlässiges ScoreLog,
- vollständiges fachliches Auditlog,
- journald-Aufbewahrung und Größenbegrenzung,
- zentrale Frontend-Fehlererfassung.

Version 4.3.0 selbst enthält keine wesentliche Logging-Änderung.

**Backlog-Status**

| Paket | Aktueller Status |
|---|---|
| L1 Richtlinie und Datenklassifikation | offen |
| L2 Frontend-Logs bereinigen | teilweise umgesetzt |
| L3 Antwortdaten minimieren | weitgehend umgesetzt |
| L4 Strukturierter Backend-Logger | offen |
| L5 Korrelation | teilweise umgesetzt |
| L6 Poller-Logging | teilweise umgesetzt |
| L7 HTTP-/WebSocket-Logging | teilweise umgesetzt |
| L8 Zuverlässiges ScoreLog | offen |
| L9 Auditlog | offen |
| L10 Liveness/Readiness/Metriken | Readiness umgesetzt, Metriken offen |
| L11 Caddy/journald | weitgehend offen |
| L12 Prozesslebenszyklus | teilweise umgesetzt |
| L13 Frontend-Fehlererfassung | weitgehend offen |
| L14 Tests und Rollout | teilweise umgesetzt |

Aktuell bestehen weiterhin etwa 39 Backend-Runtime- und 42 Frontend-`console.*`-Aufrufe.

**Priorität 0: Konkrete Risiken schließen**
1. ScoreLog vor Formel-Injection schützen. `cleanScore()` akzeptiert derzeit unter anderem mit `=` beginnende Werte, die anschließend per `USER_ENTERED` geschrieben werden (`Backend/courtPoller.js:78`, `Backend/courtPoller.js:137`). Die fachlich erlaubten Scorewerte müssen als Allowlist definiert und Sheet-Writes als `RAW` ausgeführt werden. Das dreispaltige Format kann dabei zunächst erhalten bleiben.

2. Verbleibende personenbezogene Browserlogs entfernen. Besonders die persönliche Sperrzeit in `Frontend/JS/rangliste.js:258` sowie die dauerhaften Ranglisten-Debuglogs gehören entfernt oder strikt entwicklungsabhängig gemacht.

3. Keine vollständigen `Error`-Objekte mehr im Browser loggen. Sie können serverseitige `details` enthalten. In der Konsole dürfen höchstens kontrollierte Felder wie `code`, `category` und `supportId` erscheinen.

4. Bekannten `/status.lastRequest`-Fehler korrigieren. Ein vor der Handlerausführung abgewiesener Request kann aktuell seine Support-ID an den vorherigen Request anhängen (`Backend/dataProvider.js:586`, `Backend/dataProvider.js:734`). Jeder Requestversuch braucht einen eigenen atomaren Diagnosedatensatz.

5. Support-IDs verlässlich suchbar machen. Viele 4xx-Antworten enthalten eine Referenz, erzeugen aber keinen Serverlogeintrag. Entweder muss zu jeder ausgegebenen Support-ID ein redigiertes Ereignis existieren oder die UI darf sie nicht als Supportreferenz darstellen.

6. Interne Google-Fehler nicht an Clients geben. `withdrawFromRanking()` baut `error.message` in einen öffentlichen `AppError` ein (`Backend/sheetService.js:731`). Extern sollte nur ein neutraler Code erscheinen.

7. Profildaten beim Schließen und Logout aus dem DOM entfernen. E-Mail, Telefon und Geburtsdatum bleiben derzeit im versteckten Profilmodal erhalten (`Frontend/JS/modals.js:79`, `Frontend/JS/modals.js:298`).

**Priorität 1: Richtlinie und zentralen Logger schaffen**
Vor breiterem Request- oder Access-Logging müssen L1 und L4 gemeinsam umgesetzt werden:

- Logkategorien, erlaubte Felder und Datenklassen festlegen.
- Behandlung von IP, Benutzer-ID, Client-ID und Gerätenummer entscheiden.
- Aufbewahrung, Zugriff und Löschung je Logkanal bestimmen.
- Zentralen Backend-Logger mit JSON-Ausgabe einführen.
- Pflichtfelder `timestamp`, `level`, `service`, `environment`, `instance`, `version` und `event` verwenden.
- Rekursive Redaction für Cookies, Tokens, Passwortmaterial, E-Mail und andere festgelegte Felder implementieren.
- Loglevel über Konfiguration steuerbar machen.
- Fehler intern mit Code, Klasse und Stack erfassen.
- Redaction- und JSON-Schema-Tests ergänzen.

Bestehende `console.*`-Stellen sollten danach ereignisweise migriert werden, nicht durch unstrukturierte Zusatzlogs ergänzt werden.

**Priorität 2: Ende-zu-Ende-Korrelation**
Nach dem zentralen Logger:

- HTTP-Request-ID erzeugen beziehungsweise vertrauenswürdig übernehmen und als `X-Request-ID` zurückgeben.
- Für WebSockets Client-Request-ID und serverseitige Correlation-ID getrennt führen.
- Jeden Requestabschluss mit Route beziehungsweise Endpoint, Status, Dauer, Ergebnis und Fehlercode protokollieren.
- Validierungs-, Auth-, Rate-Limit- und Parsefehler ebenfalls erfassen.
- Keine Payloads protokollieren.
- Korrelation an Sheet-Writes und das spätere Auditlog weitergeben.
- Support-ID in allen Fehleroverlays erhalten.
- Caddy später in dieselbe Korrelation einbinden.

**Priorität 3: Poller und Prozesszustände wahrheitsgemäß machen**
- Pollergebnisse in `angewendet`, `durch Fencing ignoriert`, `fehlgeschlagen` und `ignorierter alter Fehler` unterscheiden.
- Dauer, Fehlercode, Folgefehlerzahl, Ausfallbeginn und Recovery pro Tabelle erfassen.
- Wiederholte Fehler unterdrücken und periodisch zusammenfassen.
- Nicht mehr jeden normalen Tick als Textlog ausgeben.
- Court-Readiness überprüfen: Gegenwärtig macht bereits ein einzelner Fetchfehler die Quelle sofort stale (`Backend/courtPoller.js:179`), auch wenn der letzte Erfolg noch innerhalb des Alterslimits liegt.
- Startup-, Ready-, Shutdown-Beginn-, Shutdown-Ende- und Fatal-Ereignisse standardisieren.
- `unhandledRejection`, `uncaughtException` und dauerhafte HTTP-Serverfehler behandeln.
- Ergebnisse von `Promise.allSettled()` beim Shutdown tatsächlich auswerten.
- Sicheren Diagnosezugriff planen, der auch dann funktioniert, wenn die Tabelle `Personen` stale ist. Momentan kann gerade dieser Ausfall den Adminzugriff auf `/status` verhindern (`Backend/authService.js:248`).

**Priorität 4: ScoreLog zuverlässig machen**
Nach der unmittelbaren `RAW`-Absicherung sollte das eigentliche Redesign erfolgen:

- Event-ID und Sequenznummer definieren.
- Persistente SQLite-Queue für noch nicht bestätigte Scoreereignisse verwenden.
- Geordnete Writes, Retry und Backoff implementieren.
- Ambige Append-Ausgänge und Dead-Letter-Verhalten festlegen.
- Persistierten Score erst nach bestätigtem Append aktualisieren.
- Queue bei SIGTERM mit Zeitlimit drainieren.
- Queuegröße, ältestes Ereignis und Fehlerzahl diagnostizierbar machen.
- Match-ID, Court-Aktivstatus und Instanz ergänzen.
- Sheet-Schema und Migration ausdrücklich entscheiden.

Ohne Event-ID oder vergleichbare Idempotenz ist eine zuverlässige Wiederholung nach unklarem Google-Append nicht möglich.

**Priorität 5: Fachliches Auditlog**
Das dreispaltige, editierbare Sheet `Logging` und die kurzlebige SQLite-Tabelle `operations` sind kein vollständiges Auditlog.

Benötigt werden:

- vollständige Inventur aller aktuellen Mutationen,
- authentifizierter Akteur und Rolle,
- Aktion, Zieltyp und stabile Ziel-ID,
- Request-/Event-ID,
- kontrollierter Vorher-/Nachher-Zustand,
- Ergebnis `success`, `failed` oder `unknown`,
- Tombstones für Löschungen,
- Auth-, Passwort-, Monitor-, Court-, Match-, EntryList- und Ranglistenereignisse,
- append-only beziehungsweise angemessen geschützter Speicher,
- Aufbewahrungs- und Zugriffskonzept.

Die frühere Blockade fehlender serverseitiger Identität besteht nicht mehr; aktuelle Sessions liefern einen belastbaren Principal.

**Priorität 6: Metriken und Infrastruktur**
- Requestanzahl, Fehlerquote und Dauer exportieren.
- Tabellen- und Courtdatenalter messen.
- WebSocket-Verbindungen, Close-Codes, Timeouts und Backpressure zählen.
- ScoreLog-/Auditqueue überwachen.
- Speicher, CPU und Event-Loop-Lag erfassen.
- Alarmgrenzen und Eskalationsweg definieren.
- Caddy-Access-Logging erst nach Datenschutzentscheidung aktivieren.
- Cookies, Header und sensible Queryparameter ausschließen.
- journald-Größe, Persistenz und Aufbewahrung begrenzen.
- `SyslogIdentifier`, Startlimits und Crash-Loop-Alarmierung pro Dienst ergänzen.

`/status` bleibt dabei ein flüchtiges Diagnosewerkzeug und darf nicht als Metriksystem behandelt werden.

**Priorität 7: Frontend-Diagnose und Rollout**
- Zentralen sicheren Frontend-Diagnoseadapter einführen.
- `window.error` und `unhandledrejection` erst nach Redaction-, Datenschutz- und Rate-Limit-Konzept erfassen.
- Leeren WebSocket-Error-Handler ersetzen (`Frontend/JS/dataClient.js:482`).
- Fehlgeschlagenen `/version`-Abruf nicht dauerhaft als unbekannte Version cachen.
- Neutrale sichtbare Scoreboard-Anzeige für stale beziehungsweise fehlgeschlagene Resynchronisierung vorsehen; die bestehende Logik sucht derzeit HTML-Elemente, die gar nicht existieren (`Frontend/JS/scoreboardPolling.js:452`).
- Browsertests für Support-ID, Profildatenbereinigung und stale Scoreboard ergänzen.
- PAJ-Dauerbetrieb, Logvolumen, Rotation, Google-Ausfall, Support-ID-Suche und Rollback praktisch abnehmen.

**Empfohlene Umsetzungsschnitte**
1. P0 als kleiner Sicherheits- und Konsistenzschritt.
2. L1 und zentraler Backend-Logger.
3. HTTP-/WebSocket-Korrelation und Pollerzustände.
4. ScoreLog-Persistenz.
5. Fachliches Auditlog.
6. Metriken, Caddy, journald und Alarmierung.
7. Frontend-Fehlerberichte und vollständige PAJ-Abnahme.

Für eine Aktualisierung der Analyse würde ich in `Project/2do/LOGGING-ANALYSE.md` einen neuen Abschnitt „Implementierungsstatus 2026-08-03 und neu priorisierte Restmaßnahmen“ mit genau diesem Delta und dem aktualisierten L1–L14-Status ergänzen. Das wurde noch nicht verändert.

Während der rein lesenden Analyse erschienen zusätzlich die nicht von mir vorgenommenen Löschungen `PAJ-VERSION-RELOAD-TEST.txt` und `abc.txt` im Arbeitsbaum. Ich habe sie weder verändert noch wiederhergestellt.
