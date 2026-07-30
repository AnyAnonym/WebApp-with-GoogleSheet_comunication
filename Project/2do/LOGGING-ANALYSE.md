# Analyse von Logging und Observability

Stand der Analyse: 25.07.2026  
Analysierter Stand: ePiber v3.0.2  
Gegenstand: Frontend, Backend, WebSocket, Google Sheets, systemd/journald und Caddy

Diese Datei dokumentiert den zum Analysezeitpunkt vorhandenen Zustand. Die
Verbesserungsvorschlaege waren damals nicht umgesetzt; der aktuelle Stand steht
im Schlussabschnitt "Implementierungsstatus 2026-07-29/30".

## 1. Gesamtbild

Das Projekt verwendet mehrere voneinander getrennte Diagnosekanaele:

```text
Browser
  |-- console.log / console.warn / console.error
  |-- Toasts und Fehler-Overlays
  `-- Testseiten-Log im DOM

Node.js
  |-- console.log -> stdout
  |-- console.error -> stderr
  `-- fluechtige Statuswerte ueber /health und /status

systemd
  `-- stdout/stderr -> journald -> journalctl

Google Spreadsheet
  |-- ScoreLog
  `-- Logging

Caddy
  `-- operative Meldungen, aber kein konfiguriertes HTTP-Access-Log
```

Eine zentrale Logging- oder Observability-Loesung existiert nicht. Browser, Backend, Caddy, journald und Google Sheets verwenden keine gemeinsame Event- oder Request-ID.

## 2. Bestandsaufnahme

Im eigenen Anwendungscode existieren ungefaehr:

| Bereich | `console.log` | `console.error` | `console.warn` | Gesamt |
|---|---:|---:|---:|---:|
| Frontend | 26 | 34 | 7 | 67 |
| Backend | 21 | 7 | 0 | 28 |
| Gesamt | 47 | 41 | 7 | 95 |

Zusaetzlich gibt es:

- ungefaehr 47 Frontend-Catch-Bloecke
- 14 Backend-Catch-Bloecke
- mindestens 14 bewusst stille Frontend-Catches
- einen leeren WebSocket-Error-Handler
- keine zentrale Logging-Bibliothek
- keine konfigurierbaren Log-Level
- keine strukturierten JSON-Logs
- keine durchgaengige Correlation-ID
- keinen Metrikexport

## 3. Frontend-Logging

### 3.1 Browser-Konsole

Frontend-Logs verbleiben lokal im jeweiligen Browser. Sie werden nicht automatisch an das Backend uebertragen und sind nach Reload, Browserentscheidung oder manuellem Leeren nicht mehr verfuegbar.

Typische Inhalte sind:

- WebSocket verbunden oder getrennt
- Laden fachlicher Daten
- Ranglisten- und Rasterberechnungen
- Login und Session-Wiederherstellung
- EntryList-Verarbeitung
- Navigator- und Scoreboard-Aktionen

Beispiele aus `Frontend/JS/dataClient.js`:

```js
console.log("dataClient: verbunden");
console.log("dataClient: getrennt");
```

Diese Meldungen geben keine Auskunft ueber Zeitpunkt, Client-ID, Close-Code, Fehlergrund oder Reconnect-Versuch.

### 3.2 Sensible Daten in Browser-Logs

Mehrere Logs enthalten Daten, die nicht in einer Browser-Konsole erscheinen sollten.

#### Login-E-Mail und Passwort-Hash

`Frontend/JS/modals.js` protokolliert:

```js
console.log("Login attempt (hashed):", { email, passwordHash });
```

Der Hash wird vom Backend direkt verglichen und ist damit ein wiederverwendbares Authentisierungsgeheimnis. Er darf nicht geloggt werden.

#### Vollstaendige Personen-Rohdaten

`Frontend/JS/playerList.js` protokolliert die vollstaendige Serverantwort. Der Endpoint `players` liefert die ungefilterte Tabelle `Personen`.

Diese kann enthalten:

- E-Mail-Adresse
- Telefonnummer
- Passwort-Hash
- Kennwort-Reset-Freigabe
- weitere personenbezogene Daten

Damit besteht nicht nur ein Loggingproblem, sondern bereits bei der Datenuebertragung ein Problem fehlender Datenminimierung.

#### Weitere personenbezogene Logs

Weitere Beispiele sind:

- Passwort-Reset-E-Mail in `modals.js`
- wiederhergestellte User-ID in `modals.js`
- vollstaendige Matchanfrage in `modals.js`
- erste EntryList-Datenzeile in `entryList.js`
- persoenliche Sperrzeit in `rangliste.js`

### 3.3 Entwicklungslogs im Produktivbetrieb

Mehrere Module enthalten dauerhaft aktive Debug-Ausgaben:

- EntryList-Spalten und Beispieldaten
- Turnierraster-Struktur und Rundendefinitionen
- Ranglisten-Berechnungsstaende
- geladene Datensatzanzahlen

Ein umgebungsabhaengiger Schalter wie `LOG_LEVEL=debug` existiert nicht. Dadurch werden Entwicklungs- und Betriebslogs vermischt.

## 4. Stille Frontend-Fehler

Mehrere Kommunikations- und Renderfehler werden vollstaendig verschluckt:

```js
} catch (err) {
  // silent
}
```

Betroffen sind unter anderem:

- `Frontend/JS/dataClient.js`
- `Frontend/JS/scoreboardPolling.js`
- `Frontend/JS/monitorPolling.js`
- `Frontend/JS/navigatorList.js`
- `Frontend/JS/RoundRobin.js`
- `Frontend/JS/global.js`

In `dataClient.js` wird der gesamte Fehler innerhalb der WebSocket-Nachrichtenverarbeitung ignoriert. Dadurch verschwinden beispielsweise:

- ungueltiges JSON
- unerwartete Nachrichtenschemas
- Fehler im Score-Callback
- Renderfehler
- nicht zuordenbare Responses

Auch `ws.onerror` ist leer. Die spaetere `close`-Meldung zeigt die urspruengliche Fehlerursache nicht.

Auswirkung: Eine Seite kann alte oder leere Daten anzeigen, ohne dass Benutzer oder Betreiber erkennen koennen, ob Netzwerk, Backend, Protokoll oder Rendering fehlerhaft war.

## 5. Sichtbare UI-Fehler

### 5.1 Toasts

`modals.js` verwendet Toasts fuer Benutzeraktionen wie Login, Passwort-Reset, Matchanfrage und Ergebniseingabe. Diese Meldungen sind Benutzerfeedback, aber kein dauerhaftes Log.

### 5.2 Loading- und Error-Overlay

`Frontend/JS/loadingHelper.js` stellt ein Fehler-Overlay mit Wiederholen-Schaltflaeche bereit.

Einschraenkungen:

- Meldungen verschwinden beim Reload.
- Es gibt keine Support- oder Fehler-ID.
- Betreiber koennen die Meldung nicht zentral suchen.
- Rohes `err.message` kann interne Details zeigen.
- Meldungen werden teilweise ueber `innerHTML` eingebunden.

### 5.3 Testseiten-Log

`Frontend/court-score-test.html` besitzt eine eigene sichtbare Logliste fuer Polling, WebSocket, Parsefehler und Reconnects. Sie umfasst maximal 200 DOM-Eintraege und verschwindet beim Reload.

## 6. Backend-Logging

Das Backend verwendet ausschliesslich `console.log` und `console.error`. Es gibt kein einheitliches Format und keine Logging-Bibliothek.

### 6.1 Startup

`Backend/server.js` protokolliert:

- Version
- Start des Dienstes
- Court-Defaultzustand
- Port
- Health- und Status-URL

Es fehlen:

- Umgebung `live`, `paj` oder `pk`
- Prozess- oder Instanz-ID
- Startzeit in einem einheitlichen Format
- Ergebnis einer Konfigurationsvalidierung
- eindeutige Start-ID

### 6.2 Prozessfehler und Shutdown

Nicht vorhanden sind zentrale Handler fuer:

- `uncaughtException`
- `unhandledRejection`
- `SIGTERM`
- `SIGINT`
- HTTP-Serverfehler
- geordneten Shutdown

`startup()` wird ohne abschliessendes `.catch()` aufgerufen. Bei schweren Fehlern bleibt haeufig nur der Prozessabbruch und der anschliessende Systemd-Neustart als Indikator.

## 7. DataPoller-Logging

`Backend/dataPoller.js` protokolliert:

- initiales Laden
- Poller-Start und -Stop
- Fehler einzelner Tabellen
- Fast-/Slow-Ticks

### 7.1 Irrefuehrende Erfolgsmeldungen

`pollTable()` faengt Fehler ab und liefert `false`. `pollCategory()` und `initialLoad()` werten die Rueckgabewerte nicht aus.

Dadurch kann nach mehreren Fehlern trotzdem erscheinen:

```text
dataPoller: Tick #660 - fast+slow aktualisiert
```

Ebenso kann `Initiales Laden abgeschlossen` geloggt werden, obwohl einzelne oder alle Tabellen fehlgeschlagen sind.

Die Erfolgsmeldung bestaetigt damit keinen geprueften Gesamterfolg.

### 7.2 Fehlender Kontext

Ein Tabellenfehler enthaelt derzeit Tabellenname, Range und `err.message`.

Es fehlen:

- Fehlerklasse und Google-API-Code
- Fehlerzaehler
- Anzahl aufeinanderfolgender Fehler
- letzter erfolgreicher Abruf
- Requestdauer
- Hinweis auf weiterverwendete alte Daten
- Wiederherstellungsereignis

### 7.3 Log-Spam bei Dauerfehlern

Ein dauerhafter Authentifizierungsfehler wird fuer jede Tabelle bei jedem Poll erneut geloggt. Es gibt keine Deduplizierung, Rate-Limitierung oder Zusammenfassung.

Sinnvoller waeren Zustandsuebergaenge:

```text
WARN sheets_auth_failed affected_tables=8 consecutive_failures=1
WARN sheets_auth_failed suppressed=47 duration=5m
INFO sheets_auth_recovered outage_duration=8m
```

## 8. CourtPoller und ScoreLog

Der Court-Poller nutzt zwei Logging-Wege:

1. operative Meldungen ueber `console.*`
2. dauerhafte Scoreaenderungen im Google-Sheet `ScoreLog`

### 8.1 Operative Meldungen

Protokolliert werden:

- Polling gestartet
- Polling gestoppt
- HTTP-, Fetch- oder JSON-Fehler
- ScoreLog-Schreibfehler

Nicht protokolliert werden:

- Dauer des Fetches
- Alter der empfangenen Court-Daten
- letzter erfolgreicher Fetch
- Datenmenge
- Zahl der Broadcast-Empfaenger
- Erfolg des WebSocket-Broadcasts

### 8.2 ScoreLog-Schema

| Feld | Inhalt |
|---|---|
| Timestamp | Wiener Zeit |
| PlatzNr | `1` oder `2` |
| Score | zum Beispiel `6-0/1-2/0-0/40-30` |

### 8.3 Fire-and-forget

`writeScoreLog()` wird ohne `await` aufgerufen. Dadurch koennen:

- mehrere Writes parallel laufen,
- Eintraege in anderer Reihenfolge ankommen,
- laufende Writes beim Prozessende verloren gehen,
- Google-API-Limits ohne Backpressure erreicht werden.

### 8.4 Dauerhafte Luecke nach Fehler

Der letzte Score wird intern aktualisiert, bevor der Append erfolgreich abgeschlossen ist. Schlaegt das Schreiben fehl, gilt der Score trotzdem als verarbeitet. Ohne weitere Scoreaenderung erfolgt kein Retry.

### 8.5 Neustart-Duplikate

Der zuletzt bekannte Score befindet sich nur im Arbeitsspeicher. Nach einem Neustart wird der erste empfangene Stand erneut als Scoreaenderung protokolliert.

Aktueller Stand seit v4.1.0: Der erste externe Stand nach Start, Aktivierung oder
Reset wird nur als Baseline gespeichert und nicht geloggt. Erst eine spaetere
Abweichung eines aktiven Courts aktualisiert Anzeige und ScoreLog. Die fehlende
Score-Persistenz und damit der Verlust des sichtbaren In-Memory-Stands bei einem
Backendneustart bleiben bestehen.

### 8.6 Fehlende fachliche Zuordnung

Im ScoreLog fehlen:

- Match-ID
- Bewerb
- Spieler
- Event-ID
- Sequenznummer
- vorheriger Score
- Backend-Instanz
- Aktivstatus des Courts

Eine spaetere eindeutige Zuordnung zu einem Match ist daher eingeschraenkt.

## 9. Google-Sheet `Logging`

Der Tab `Logging` wird aktuell nur von `withdrawFromRanking` beschrieben.

Gespeichert werden:

- Timestamp
- Aktion
- Klartext mit Spielername, Rang, Bewerb und Begruendung

Nicht protokolliert werden unter anderem:

- Loginversuche
- Passwortaenderungen
- Matchdatum-Aenderungen
- Ergebniseintraege
- neue Matches
- EntryList-Aenderungen
- Court-Zuweisungen und Aktivierungen
- Navigator-Befehle

### 9.1 Fehlende Vertrauensbasis

User-ID, Rang, Bewerb und Begruendung kommen teilweise direkt vom Client. Ohne belastbare serverseitige Sitzung ist der tatsaechliche Akteur nicht sicher feststellbar.

### 9.2 Keine Manipulationssicherheit

Spreadsheet-Inhalte koennen nachtraeglich bearbeitet oder geloescht werden. Der Tab ist deshalb kein unveraenderbares Auditlog.

### 9.3 Formula-Injection

Freitext wird mit `USER_ENTERED` geschrieben. Beginnt eine Eingabe mit einem Formelzeichen, kann Google Sheets sie als Formel interpretieren.

## 10. WebSocket-Logging

Das Backend protokolliert:

- Client verbunden
- Client getrennt
- Socketfehler
- Client nach 90 Sekunden ohne Pong entfernt

Im RAM werden Client-ID, Verbindungszeitpunkt und letzter Endpoint gehalten.

Es fehlen:

- Remote-IP oder datenschutzgerechte Netzwerkkennung
- User-Agent und Origin
- Seitentyp oder Subscription
- authentifizierter Benutzer
- Close-Code und Close-Grund
- Dauer der Verbindung
- Ping-/Pong-Latenz
- Requestanzahl und Requestdauer
- Fehlerstatus pro Endpoint
- Score-Pushes pro Client
- Backpressure und `bufferedAmount`

Bei einem Message-Fehler werden Client-ID, Request-ID, Endpoint und Message-Typ nicht mitgeloggt. Der Client erhaelt oft keine Fehlerresponse und wartet bis zum Timeout.

## 11. Backend-Schreiboperationen und Audit

Viele Backend-Catches geben nur eine Fehlerantwort an den Client zurueck:

```js
} catch (err) {
  return { success: false, error: err.message };
}
```

Das betrifft unter anderem:

- Passwortaenderung
- Matchdatum
- Matchergebnis
- Matchanlage
- EntryList hinzufuegen
- EntryList entfernen
- Ranglistenrueckzug

Diese Fehler koennen in journald vollstaendig fehlen. Wenn der Client sie ebenfalls verschluckt, existiert kein dauerhafter Nachweis.

`removeEntryList` loescht eine Tabellenzeile physisch, ohne vorher einen Audit-Eintrag mit dem alten Inhalt anzulegen.

## 12. HTTP-Logging

`Backend/server.js` protokolliert keine eingehenden HTTP-Requests.

Nicht erfasst werden:

- Methode und Pfad
- Statuscode
- Antwortdauer
- Remote-IP
- User-Agent und Origin
- Request- und Responsegroesse

Ein Fehler in `/set-active` wird nur als HTTP-400-Antwort ausgegeben, aber nicht serverseitig geloggt.

Unbekannte Pfade liefern HTTP 200. Dadurch sind fehlerhafte URLs weder anhand eines korrekten 404-Status noch anhand eines Logs klar erkennbar.

## 13. Health und Status

### 13.1 `/health`

Der Endpoint liefert Version, Datenbereitschaft, Court-Status, Clientzahl und Poller-Status. Er antwortet jedoch immer mit HTTP 200 und `status: "ok"`.

Das gilt auch, wenn:

- Daten nicht bereit sind,
- Google-Sheets-Abfragen dauerhaft fehlschlagen,
- Daten stark veraltet sind,
- Court-Polling defekt ist.

Der Endpoint weist daher primaer nach, dass der Node-Prozess HTTP-Anfragen beantwortet. Er ist keine belastbare Readiness-Pruefung.

### 13.2 `/status`

`/status` liefert den aktuellen In-Memory-Zustand, aber keine Historie. Der Endpoint ist ueber Caddy oeffentlich erreichbar und zeigt interne Client- und Pollinginformationen.

## 14. systemd und journald

Die Systemd-Services besitzen keine expliziten Logging-Direktiven. Damit gelten die Defaults:

```text
console.log   -> stdout -> journald
console.error -> stderr -> journald
```

Abruf fuer PAJ:

```bash
sudo journalctl -u epiber-paj -f -o cat
```

Im Repository nicht definiert sind:

- persistente oder fluechtige Journal-Speicherung
- maximale Groesse
- Aufbewahrungsdauer
- zentrale Weiterleitung
- Backup und Loeschprozess

Durch `Restart=always` und `RestartSec=5` kann ein dauerhaft fehlschlagender Start alle fuenf Sekunden neue Startup- und Fehlerlogs erzeugen.

## 15. Caddy-Logging

Im `Project/server-configs/Caddyfile` ist kein `log`-Block vorhanden. Regulare HTTP-Zugriffe werden daher nicht in einem konfigurierten Access-Log erfasst.

Es fehlen damit insbesondere:

- Host
- Methode und URI
- Statuscode
- Antwortdauer
- Upstream-Fehler
- Client-IP oder anonymisierte Kennung
- uebertragene Datenmenge
- Request-ID

Caddys eigene operative Proxy- und TLS-Meldungen koennen ueber den Caddy-Systemd-Service in journald erscheinen. Format und Aufbewahrung sind im Projekt nicht festgelegt.

## 16. Lebenszyklus der Logs

### 16.1 Entstehung

| Quelle | Ausloeser |
|---|---|
| Browser-Konsole | Laden, Benutzeraktion, Fehler |
| UI | Toasts und Overlays |
| Backend-Konsole | Start, Polling, WebSocket, Fehler |
| ScoreLog | Aenderung eines Court-Scores |
| Logging | Rueckzug aus Rangliste |
| Caddy | operative Proxy- und TLS-Ereignisse |

### 16.2 Transport und Speicherung

| Kanal | Transport | Speicherung |
|---|---|---|
| Browser-Konsole | lokal | fluechtig |
| UI-Overlay | DOM | bis Reload oder Schliessen |
| Backend-Konsole | stdout/stderr | journald |
| Backend-Status | intern | RAM bis Neustart |
| ScoreLog | Google Sheets API | Spreadsheet |
| Logging | Google Sheets API | Spreadsheet |
| Caddy | Prozessausgabe | journald, hostabhaengig |

### 16.3 Abruf

- Browser-Entwicklerwerkzeuge
- sichtbare Toasts und Overlays
- `journalctl`
- `/health` und `/status`
- Google-Sheets-Tabs `ScoreLog` und `Logging`
- `journalctl -u caddy`

### 16.4 Aufbewahrung und Loeschung

Es existiert keine dokumentierte Aufbewahrungsregel.

- Browser- und UI-Logs sind fluechtig.
- In-Memory-Zaehler verschwinden beim Neustart.
- journald richtet sich nach der Hostkonfiguration.
- Spreadsheet-Logs wachsen potenziell unbegrenzt.
- automatische Archivierung und Bereinigung fehlen.

## 17. Korrelation

Der Client erzeugt IDs wie `req-1`, `req-2` und `req-3`. Diese dienen nur der Zuordnung einer WebSocket-Antwort.

Sie werden nicht:

- im Backend geloggt,
- mit der WebSocket-Client-ID verbunden,
- in Caddy-Logs uebernommen,
- in ScoreLog oder Auditlog gespeichert,
- als Support-ID in der UI angezeigt.

Browser-Konsole, journald und Spreadsheet koennen deshalb nur manuell anhand ungefaehr gleicher Uhrzeiten verglichen werden.

## 18. Metriken

Vorhandene fluechtige Werte:

- WebSocket-Clientanzahl
- Poller-Tickzahl
- Pollcount pro Tabelle
- letzter erfolgreicher Tabellenabruf
- Tabellenzeilenzahl
- Court-Pollcount
- Court-Pushcount
- Court-Aktivstatus

Fehlende Werte:

- Requests und Fehler pro Endpoint
- Requestdauer
- Reconnects und Timeouts
- Google-API-Latenzen und Fehlercodes
- Court-Datenalter
- ScoreLog-Queue und Schreibfehler
- Prozessspeicher und CPU
- Event-Loop-Lag
- Systemd-Restarts
- Caddy-Statuscodes

Ein `/metrics`-Endpoint oder externes Metriksystem existiert nicht.

## 19. Empfohlenes Zielbild

### 19.1 Operatives JSON-Log

```json
{
  "timestamp": "2026-07-25T10:15:30.123Z",
  "level": "error",
  "service": "epiber-backend",
  "environment": "paj",
  "version": "3.0.2",
  "event": "sheets_poll_failed",
  "table": "Matches1",
  "errorCode": "INVALID_GRANT",
  "consecutiveFailures": 4
}
```

### 19.2 Request-Log

```json
{
  "event": "ws_request_completed",
  "requestId": "uuid",
  "clientId": "client-12",
  "endpoint": "matches1",
  "durationMs": 18,
  "success": true
}
```

### 19.3 Auditlog

```json
{
  "eventId": "uuid",
  "timestamp": "2026-07-25T10:20:00Z",
  "actorId": "42",
  "action": "match_result_changed",
  "entityType": "match",
  "entityId": "123",
  "requestId": "uuid",
  "success": true
}
```

### 19.4 Metriken

```text
epiber_ws_clients
epiber_ws_request_duration
epiber_sheets_poll_errors
epiber_sheets_data_age
epiber_court_data_age
epiber_scorelog_queue_size
```

## 20. Verbesserungsvorschlaege

### Prioritaet 1: Sensible Daten schuetzen

- Login-E-Mail und Passwort-Hash niemals loggen.
- Vollstaendige Personen-Rohdaten nicht im Browser loggen oder ausliefern.
- `players` auf benoetigte oeffentliche Felder reduzieren.
- Personen-, Match- und EntryList-Daten nur redigiert protokollieren.
- Keine kompletten Request-Payloads mit personenbezogenen Daten loggen.
- Testsysteme ebenfalls ueber TLS/WSS betreiben.

### Prioritaet 2: Fehler sichtbar und wahrheitsgemaess machen

- Stille Catch-Bloecke durch kontrollierte Fehlerbehandlung ersetzen.
- Poller-Erfolg nur melden, wenn die Tabellen wirklich erfolgreich waren.
- Bei Teilfehlern erfolgreiche und fehlgeschlagene Tabellen zaehlen.
- Fehlerzustaende als Uebergaenge loggen: erstmalig, weiterhin, wiederhergestellt.
- Wiederholte identische Fehler rate-limitieren.
- Interne Fehlerdetails loggen, extern neutrale Fehlercodes senden.
- Liveness und Readiness trennen; bei fehlender Readiness HTTP 503 verwenden.

### Prioritaet 3: Strukturiertes Backend-Logging

- Einheitliches JSON-Format einfuehren.
- Log-Level `debug`, `info`, `warn` und `error` definieren.
- Umgebung, Version und Instanz in Logs aufnehmen.
- UTC als technische Zeitbasis verwenden.
- Log-Level pro Umgebung konfigurierbar machen.
- Requestdauer, Endpoint, Resultat und Fehlercode erfassen.
- Geheimnisse und vollstaendige Payloads ausschliessen.

### Prioritaet 4: Durchgaengige Korrelation

- Global eindeutige Request-ID verwenden.
- Request-ID durch Client, WebSocket, Sheets-Write und Auditlog weiterreichen.
- Client-ID in Message-Fehlern protokollieren.
- UI-Fehler mit kurzer Support-ID anzeigen.
- WebSocket-Close-Code und Close-Grund erfassen.

### Prioritaet 5: ScoreLog zuverlaessig machen

- Writes geordnet und awaited ausfuehren.
- Queue mit Retry und Backoff verwenden.
- Letzten persistierten Score erst nach erfolgreichem Write aktualisieren.
- Event-ID und Sequenznummer aufnehmen.
- Match-ID und Court-Aktivstatus mitfuehren.
- Queue beim geordneten Shutdown abarbeiten.
- Aufbewahrung und Archivierung definieren.

### Prioritaet 6: Vollstaendiges Auditlog

Alle Mutationen auditieren:

- Passwortaenderung
- Matchdatum
- Matchergebnis
- Matchanlage
- EntryList-Eintrag und -Loeschung
- Court-Zuweisung und -Aktivierung
- Navigator-Befehl
- Ranglistenrueckzug

Ein Audit-Eintrag sollte Zeitpunkt, authentifizierten Akteur, Aktion, stabile Ziel-ID, Vorher-/Nachher-Zustand, Request-ID und Resultat enthalten. Physische Loeschungen sollten einen Tombstone hinterlassen.

### Prioritaet 7: Caddy und journald

- Caddy-Access-Logging aktivieren.
- JSON-Format und Request-ID verwenden.
- sensible Header und Parameter redigieren.
- journald-Aufbewahrung und maximale Groesse definieren.
- Systemd-Logs pro Umgebung eindeutig kennzeichnen.
- Startschleifen begrenzen oder alarmieren.
- Runbook fuer `journalctl`, Caddy und Backend-Status dokumentieren.

### Prioritaet 8: Metriken und Alarmierung

Alarmwuerdige Zustaende sind:

- Google-Sheets-Daten aelter als ein definierter Grenzwert
- mehrere Pollingfehler in Folge
- aktiver Court ohne aktuelle Score-Daten
- wachsende ScoreLog-Queue
- ungewoehnlich viele WebSocket-Trennungen
- wiederholte Backend-Neustarts
- auffaellig viele Schreibfehler

### Prioritaet 9: Datenschutz und Aufbewahrung

- Aufbewahrungsdauer pro Logtyp festlegen.
- Debug-Logs kurz, operative Logs begrenzt und Auditlogs fachlich begruendet aufbewahren.
- Zugriff auf Logs nach Rollen beschraenken.
- automatische Rotation und Bereinigung konfigurieren.
- fuer personenbezogene Logs einen dokumentierten Loeschprozess festlegen.

## 21. Gesamtbewertung

| Bereich | Bewertung |
|---|---|
| Browser-Debugging | vorhanden, aber inkonsistent |
| Schutz sensibler Logdaten | kritisch |
| Backend-Fehlerlogging | rudimentaer |
| WebSocket-Logging | nur Verbindungsgrunddaten |
| HTTP-Logging | praktisch nicht vorhanden |
| Caddy-Access-Logging | nicht aktiviert |
| journald-Integration | implizit vorhanden |
| ScoreLog-Zuverlaessigkeit | eingeschraenkt |
| fachliches Auditlog | nahezu nicht vorhanden |
| Korrelation | nicht vorhanden |
| Metriken | rudimentaer und fluechtig |
| Aufbewahrung und Rotation | nicht definiert |
| Health/Readiness | teilweise irrefuehrend |

Die wichtigste erste Massnahme ist nicht das Hinzufuegen moeglichst vieler Logs. Zuerst muessen sensible Daten aus Browser-Logs und Serverantworten entfernt werden. Danach sollte das Backend strukturierte, korrelierbare und wahrheitsgemaesse Logs erzeugen. Fachliche Aenderungen gehoeren in ein getrenntes Auditlog, waehrend wiederkehrende Betriebszustaende als Metriken erfasst werden sollten.

## 22. Detaillierter Umsetzungs-Backlog

Die Arbeitspakete trennen bewusst operative Logs, fachliche Auditlogs, Metriken und Benutzerfehlermeldungen. Vor der Umsetzung muss festgelegt werden, welche Daten in welcher Umgebung gespeichert werden duerfen.

### Arbeitspaket L1: Logging-Richtlinie und Datenklassifikation

Ziel: Vor technischen Aenderungen verbindlich festlegen, welche Daten geloggt werden duerfen.

Aufgaben:

- [ ] Logkategorien `operativ`, `security`, `audit`, `debug` und `metric` definieren.
- [ ] Datenklassen `oeffentlich`, `intern`, `personenbezogen`, `geheim` definieren.
- [ ] Passwort, Passwort-Hash, Service-Account-Key und Session-Token als niemals loggbare Geheimnisse festlegen.
- [ ] E-Mail, Telefon, Geburtsdatum und IP-Adresse als personenbezogene Daten klassifizieren.
- [ ] Regeln fuer Maskierung, Pseudonymisierung und vollstaendiges Weglassen dokumentieren.
- [ ] Erlaubte Felder pro Logkategorie definieren.
- [ ] Aufbewahrungsdauer pro Logkategorie fachlich und rechtlich abstimmen.
- [ ] Zugriffsrollen fuer Browserdiagnose, journald, Caddy, Auditlog und Metriken festlegen.
- [ ] Verantwortliche Person fuer Logzugriff und Loeschanforderungen benennen.
- [ ] Eine Checkliste fuer neue Logstellen in Code-Reviews erstellen.

Abnahmekriterien:

- [ ] Fuer jedes aktuell geloggte sensible Feld ist dokumentiert, ob es entfernt, maskiert oder erlaubt wird.
- [ ] Kein Geheimnis ist in einer erlaubten Logfeldliste enthalten.
- [ ] Aufbewahrung und Zugriffsrollen sind fuer alle Logkanaele festgelegt.

Abhaengigkeiten: keine; muss vor allen weiteren Logging-Arbeiten abgeschlossen sein.

### Arbeitspaket L2: Kritische Frontend-Logs bereinigen

Ziel: Sensible Daten duerfen nicht mehr in Browserkonsolen erscheinen.

Aufgaben:

- [ ] Login-Log mit E-Mail und Passwort-Hash entfernen.
- [ ] Vollstaendige Personen-Rohdaten aus `playerList.js` nicht mehr loggen.
- [ ] Passwort-Reset-E-Mail aus Konsolenlogs entfernen oder strikt redigieren.
- [ ] User-ID und vollstaendige Matchanfragen aus allgemeinen Produktivlogs entfernen.
- [ ] EntryList-Beispielzeilen und andere Rohdatenausgaben entfernen.
- [ ] Ranglisten- und Raster-Debuglogs auf nicht personenbezogene Zusammenfassungen reduzieren.
- [ ] Einen zentralen Frontend-Logger mit `debug`, `info`, `warn` und `error` vorsehen.
- [ ] Debugausgaben nur in explizit aktivierter Entwicklungsumgebung zulassen.
- [ ] Objekt-Payloads vor dem Loggen ueber eine Redaction-Funktion fuehren.
- [ ] Automatische Suche nach Begriffen wie `password`, `passwdhash`, `token`, `email` und `private_key` in Logaufrufen in die Pruefung aufnehmen.

Abnahmekriterien:

- [ ] Login und Passwort-Reset erzeugen keine Geheimnisse oder personenbezogenen Daten in DevTools.
- [ ] `players.html` gibt keine vollstaendige Serverantwort in der Konsole aus.
- [ ] Produktivbetrieb zeigt nur Warnungen und Fehler mit redigiertem Kontext.
- [ ] Eine statische Suche findet keine bekannten Geheimnisfelder in aktiven Logaufrufen.

Abhaengigkeiten: L1.

### Arbeitspaket L3: Datenminimierung der Backend-Antworten

Ziel: Daten, die ein Browser nicht erhaelt, koennen dort weder geloggt noch ausgelesen werden.

Aufgaben:

- [ ] Alle Frontend-Nutzungen des Endpoints `players` inventarisieren.
- [ ] Oeffentliche Spielerprojektion mit ausschliesslich benoetigten Feldern definieren.
- [ ] Geschuetzte Profilprojektion fuer den eigenen Benutzer definieren.
- [ ] Passwort-Hash und Kennwort-Reset-Spalte aus allen allgemeinen Responses entfernen.
- [ ] E-Mail und Telefon nur an fachlich berechtigte Rollen liefern.
- [ ] Separate Endpoints statt ungefilterter Tabellenantworten verwenden.
- [ ] Response-Schemas dokumentieren und validieren.
- [ ] Tests erstellen, die verbotene Felder in Antworten explizit ausschliessen.
- [ ] Bestehende Frontendmodule auf die neuen Projektionen umstellen.
- [ ] Alte ungefilterte Responses nach einer Uebergangsphase entfernen.

Abnahmekriterien:

- [ ] Ein anonymer Client kann keinen Passwort-Hash oder Resetstatus abrufen.
- [ ] Oeffentliche Seiten erhalten nur die fuer ihre Darstellung notwendigen Felder.
- [ ] Schema-Tests schlagen fehl, sobald ein verbotenes Feld erneut ausgeliefert wird.

Abhaengigkeiten: L1; Authentifizierung ist fuer geschuetzte Projektionen erforderlich.

### Arbeitspaket L4: Strukturierter Backend-Logger

Ziel: Alle Backend-Logs sollen einheitlich, maschinenlesbar und redigiert sein.

Aufgaben:

- [ ] Logging-Bibliothek oder kleinen zentralen Logger auswaehlen.
- [ ] JSON als Produktionsformat festlegen.
- [ ] Pflichtfelder `timestamp`, `level`, `service`, `environment`, `version` und `event` definieren.
- [ ] UTC und ISO-8601 fuer technische Zeitstempel verwenden.
- [ ] Umgebung aus einer validierten Konfiguration beziehen.
- [ ] Log-Level ueber Umgebungsvariable konfigurierbar machen.
- [ ] Redaction fuer Geheimnis- und Personenfelder zentral konfigurieren.
- [ ] Fehlerobjekte mit Name, Code und Stack intern strukturiert erfassen.
- [ ] Bestehende `console.log/error` schrittweise auf benannte Events umstellen.
- [ ] Startup-, Shutdown- und Konfigurationsereignisse standardisieren.
- [ ] Fallback-Verhalten definieren, falls der Logger selbst fehlschlaegt.

Abnahmekriterien:

- [ ] Jedes Backend-Log ist gueltiges JSON oder bewusst als lokales Pretty-Format konfiguriert.
- [ ] Umgebung und Version sind in jedem Event enthalten.
- [ ] Fehler besitzen einen Stack im geschuetzten Serverlog.
- [ ] Redaction-Tests verhindern das Loggen definierter Geheimnisfelder.

Abhaengigkeiten: L1.

### Arbeitspaket L5: Request- und Correlation-ID

Ziel: Browseraktion, WebSocket-Request, Backendverarbeitung und Audit-Eintrag muessen zusammengefuehrt werden koennen.

Aufgaben:

- [ ] Global eindeutige UUID pro Frontend-Request erzeugen.
- [ ] Client-ID und Request-ID in jeder WebSocket-Anfrage mitfuehren.
- [ ] Request-ID in jeder Response zurueckgeben.
- [ ] Request-ID in Backend-Start-, Erfolgs- und Fehlerlog aufnehmen.
- [ ] Fuer HTTP-Anfragen Request-ID aus Header uebernehmen oder serverseitig erzeugen.
- [ ] Caddy-Request-ID, soweit praktikabel, an das Backend weiterreichen.
- [ ] Request-ID an Sheets-Write- und Auditfunktionen uebergeben.
- [ ] Eine kurze, benutzerfreundliche Support-ID aus der Request-ID anzeigen.
- [ ] Keine komplette UUID als personenbezogene Geraeteverfolgung dauerhaft im Browser speichern.
- [ ] Dokumentieren, wie Support eine Support-ID in journald oder zentralen Logs sucht.

Abnahmekriterien:

- [ ] Ein fehlgeschlagener Frontend-Request kann eindeutig im Backend-Log gefunden werden.
- [ ] Ein Audit-Eintrag verweist auf denselben Request.
- [ ] IDs kollidieren nicht zwischen verschiedenen Browsern oder Seitenreloads.

Abhaengigkeiten: L4; Kommunikationsclient muss die IDs transportieren.

### Arbeitspaket L6: Poller-Logging wahrheitsgemaess gestalten

Ziel: Poller-Logs sollen Erfolg, Teilfehler, Dauer und Wiederherstellung korrekt wiedergeben.

Aufgaben:

- [ ] Rueckgabewerte aller `pollTable()`-Aufrufe aggregieren.
- [ ] `initialLoad()` nur bei vollstaendigem Erfolg als erfolgreich melden.
- [ ] Kritische und optionale Tabellen definieren.
- [ ] Teilfehler als strukturiertes Warnereignis ausgeben.
- [ ] Dauer pro Tabelle und Gesamtlauf messen.
- [ ] Fehlercode und Fehlerklasse erfassen.
- [ ] `lastSuccessAt`, `lastErrorAt` und `consecutiveFailures` pro Tabelle speichern.
- [ ] Identische Folgefehler rate-limitieren.
- [ ] Anzahl unterdrueckter Wiederholungen regelmaessig zusammenfassen.
- [ ] Wiederherstellung nach Fehler als eigenes Info-Event loggen.
- [ ] Datenalter pro Tabelle fuer Readiness und Metriken bereitstellen.
- [ ] Tests fuer Vollerfolg, Teilfehler, Totalausfall und Recovery erstellen.

Abnahmekriterien:

- [ ] Nach einem `invalid_grant` erscheint keine irrefuehrende Erfolgsmeldung.
- [ ] Ein Dauerfehler erzeugt keinen ungebremsten Logstrom.
- [ ] Recovery und Ausfalldauer sind aus den Logs ablesbar.
- [ ] Der letzte erfolgreiche Stand jeder Tabelle ist sichtbar.

Abhaengigkeiten: L4.

### Arbeitspaket L7: WebSocket- und HTTP-Request-Logging

Ziel: Kommunikationsfehler sollen pro Client und Request nachvollziehbar sein.

Aufgaben:

- [ ] WebSocket-Verbindung mit Client-ID, Seitentyp, Origin und Startzeit loggen.
- [ ] Remote-IP nur gemaess Datenschutzrichtlinie speichern oder anonymisieren.
- [ ] Request-Start und -Ende mit Endpoint, Dauer und Erfolg erfassen.
- [ ] Payload-Inhalte nicht standardmaessig loggen.
- [ ] Payload-Groesse und Antwortgroesse als Zahlen erfassen.
- [ ] Unbekannte Endpoints als Warnereignis loggen.
- [ ] Message-Parsefehler mit Client- und Request-Kontext loggen.
- [ ] Close-Code, Close-Grund und Verbindungsdauer erfassen.
- [ ] Ping-/Pong-Timeouts und Stale-Disconnects unterscheiden.
- [ ] Broadcast-Empfaengerzahl und Sendefehler erfassen.
- [ ] HTTP-Methode, Route, Status und Dauer erfassen.
- [ ] `/set-active`-Fehler serverseitig protokollieren.
- [ ] Unbekannte HTTP-Pfade mit 404 beantworten und rate-limitiert loggen.

Abnahmekriterien:

- [ ] Jeder fehlgeschlagene Endpoint-Aufruf besitzt Request-ID, Endpoint, Fehlercode und Dauer.
- [ ] WebSocket-Trennungen unterscheiden normalen Seitenwechsel, Timeout und Netzwerkfehler soweit technisch moeglich.
- [ ] Keine fachliche Payload wird ungeprueft in operative Logs geschrieben.

Abhaengigkeiten: L4 und L5.

### Arbeitspaket L8: ScoreLog zuverlaessig machen

Ziel: Jede fachlich relevante Scoreaenderung soll geordnet und nachvollziehbar persistiert werden.

Aufgaben:

- [ ] ScoreLog-Writes ueber eine einzelne geordnete Queue ausfuehren.
- [ ] Jeden Write awaiten oder den Queueabschluss kontrollieren.
- [ ] Retry mit exponentiellem Backoff fuer temporaere Google-Fehler implementieren.
- [ ] Maximale Retryzahl und Dead-Letter-Verhalten definieren.
- [ ] Eindeutige Event-ID und Sequenznummer pro Court vergeben.
- [ ] `lastPersistedScore` erst nach erfolgreichem Append aktualisieren.
- [ ] Match-ID, Court-Aktivstatus und Backend-Instanz aufnehmen.
- [ ] Fachlich entscheiden, ob inaktive Courts geloggt werden duerfen.
- [ ] Duplikatverhalten nach Neustart definieren und verhindern.
- [ ] Queuegroesse, aeltestes Event und Fehleranzahl als Metrik bereitstellen.
- [ ] Queue bei `SIGTERM` mit Zeitlimit flushen.
- [ ] Tests fuer Reihenfolge, Retry, Neustart und Google-Ausfall erstellen.

Abnahmekriterien:

- [ ] Temporaerer Google-Ausfall erzeugt nach Recovery keine dauerhafte Luecke.
- [ ] Scoreereignisse bleiben pro Court in korrekter Reihenfolge.
- [ ] Derselbe Event wird nicht mehrfach gespeichert.
- [ ] Ein geordneter Deploy verliert keine bereits angenommenen Scoreevents.

Abhaengigkeiten: L4; geordneter Shutdown aus L12.

### Arbeitspaket L9: Fachliches Auditlog

Ziel: Jede fachliche Mutation muss mit vertrauenswuerdigem Akteur und Ergebnis nachvollziehbar sein.

Aufgaben:

- [ ] Audit-Schema mit Event-ID, Zeitpunkt, Akteur, Rolle, Aktion, Zieltyp, Ziel-ID, Request-ID und Resultat definieren.
- [ ] Authentifizierte serverseitige Identitaet statt frei uebergebener User-ID verwenden.
- [ ] Auditpflichtige Aktionen vollstaendig inventarisieren.
- [ ] Passwortaenderung ohne Passwort oder Hash, aber mit Akteur und Resultat auditieren.
- [ ] Matchdatum, Ergebnis und Matchanlage auditieren.
- [ ] EntryList-Eintrag und -Loeschung auditieren.
- [ ] Court-Zuweisung, Aktivierung und Navigator-Befehle auditieren.
- [ ] Vorher-/Nachher-Diff auf erlaubte Felder begrenzen.
- [ ] Physische Loeschungen mit Tombstone protokollieren.
- [ ] Nutzereingaben als Daten und nicht als `USER_ENTERED`-Formel schreiben.
- [ ] Geeigneten append-only Speicher ausserhalb editierbarer Fach-Sheets bewerten.
- [ ] Zugriff auf Auditdaten strikt begrenzen.
- [ ] Integritaetsschutz und regelmaessiges Backup definieren.

Abnahmekriterien:

- [ ] Jede produktive Mutation erzeugt genau einen erfolgreichen oder fehlgeschlagenen Audit-Eintrag.
- [ ] Der Akteur stammt aus einer serverseitig validierten Sitzung.
- [ ] Geheimnisse sind weder im Vorher-/Nachher-Diff noch im Fehlertext enthalten.
- [ ] Geloeschte EntryList-Eintraege bleiben auditierbar.

Abhaengigkeiten: Authentifizierung, L1, L4 und L5.

### Arbeitspaket L10: Liveness, Readiness und Metriken

Ziel: Logs sollen nicht fuer laufende Zustandsmessung missbraucht werden; messbare Werte sollen alarmierbar sein.

Aufgaben:

- [ ] `/live` fuer Prozess- und Event-Loop-Liveness definieren.
- [ ] `/ready` fuer aktuelle kritische Datenquellen definieren.
- [ ] Maximales Datenalter pro Tabelle und Court festlegen.
- [ ] Bei fehlender Readiness HTTP 503 liefern.
- [ ] `/status` vor oeffentlichem Zugriff schuetzen.
- [ ] Metriken fuer Requests pro Endpoint und Resultat exportieren.
- [ ] Histogramme fuer Request-, Sheets- und Court-Latenzen bereitstellen.
- [ ] WebSocket-Clients, Reconnects, Timeouts und Stale-Disconnects zaehlen.
- [ ] Datenalter und Pollingfehler je Tabelle messen.
- [ ] ScoreLog-Queue und Auditfehler messen.
- [ ] Prozessspeicher, CPU und Event-Loop-Lag messen.
- [ ] Alarmgrenzen und Eskalationsweg dokumentieren.

Abnahmekriterien:

- [ ] Monitoring erkennt einen lebenden, aber nicht bereiten Prozess.
- [ ] Veraltete Matches- oder Courtdaten loesen eine erkennbare Warnung aus.
- [ ] Ein Dashboard zeigt Fehlerquote, Latenz, Clientzahl und Datenalter.
- [ ] Regelmaessige Zustandswerte muessen nicht als Textlogs ausgegeben werden.

Abhaengigkeiten: L4 und L6; Auswahl eines Metriksystems.

### Arbeitspaket L11: Caddy-Access-Logs und journald

Ziel: Proxy- und Prozesslogs sollen kontrolliert gespeichert, rotiert und abrufbar sein.

Aufgaben:

- [ ] Entscheiden, ob Caddy nach journald oder in rotierende JSON-Dateien loggt.
- [ ] Access-Logging pro Umgebung konfigurieren.
- [ ] Host, Methode, URI, Status, Dauer, Groesse und Upstreamstatus erfassen.
- [ ] Authorization, Cookies und sensible Queryparameter redigieren.
- [ ] IP-Adressen gemaess Datenschutzrichtlinie anonymisieren oder kurz aufbewahren.
- [ ] Health-Check-Zugriffe samplen oder getrennt behandeln.
- [ ] journald auf persistente oder bewusst fluechtige Speicherung konfigurieren.
- [ ] `SystemMaxUse`, `RuntimeMaxUse` und `MaxRetentionSec` festlegen.
- [ ] Eindeutigen `SyslogIdentifier` pro ePiber-Service bewerten.
- [ ] Logrotation und freien Speicherplatz ueberwachen.
- [ ] Berechtigungen fuer `journalctl` und Caddy-Logs definieren.
- [ ] Abrufbefehle und typische Filter im Betriebs-Runbook dokumentieren.

Abnahmekriterien:

- [ ] Ein HTTP-Fehler kann mit Host, Route, Status und Upstreamdauer gefunden werden.
- [ ] Logs koennen die Platte nicht unbegrenzt fuellen.
- [ ] Sensible Header erscheinen nicht im Access-Log.
- [ ] Aufbewahrung entspricht der Richtlinie aus L1.

Abhaengigkeiten: L1 und L5.

### Arbeitspaket L12: Prozesslebenszyklus und Fehlergrenzen

Ziel: Absturz, Shutdown und Neustart sollen vollstaendig und ohne Logverlust nachvollziehbar sein.

Aufgaben:

- [ ] `startup().catch()` mit fatalem Event und definiertem Exitcode versehen.
- [ ] `unhandledRejection` und `uncaughtException` kontrolliert erfassen.
- [ ] Festlegen, welche Fehler einen Prozessabbruch erfordern.
- [ ] `SIGTERM` und `SIGINT` als Shutdown-Ereignis behandeln.
- [ ] Poller und neue Requests beim Shutdown stoppen.
- [ ] ScoreLog- und Auditqueues mit Zeitlimit flushen.
- [ ] WebSocket-Clients mit definiertem Close-Code informieren.
- [ ] Shutdown-Ergebnis und Dauer protokollieren.
- [ ] Systemd-Startbegrenzung und Restart-Verhalten definieren.
- [ ] Wiederholte Crash-Loops alarmieren.
- [ ] Tests fuer normalen Deploy, Fatal Error und erzwungenen Kill ausfuehren.

Abnahmekriterien:

- [ ] Jeder normale Start besitzt ein korrespondierendes Ready-Event.
- [ ] Jeder geordnete Stop besitzt Beginn, Ergebnis und Dauer.
- [ ] Ein Crash ist mit Fehlerklasse, Stack, Version und Umgebung nachvollziehbar.
- [ ] Crash-Loops erzeugen keinen ungebremsten Logstrom.

Abhaengigkeiten: L4 und L8.

### Arbeitspaket L13: Frontend-Fehlererfassung und Support

Ziel: Relevante Clientfehler sollen diagnostizierbar sein, ohne personenbezogene Daten zu sammeln.

Aufgaben:

- [ ] Zentralen Handler fuer `window.error` definieren.
- [ ] Zentralen Handler fuer `unhandledrejection` definieren.
- [ ] WebSocket-Status, Request-Timeout und Renderfehler als unterschiedliche Codes erfassen.
- [ ] Release-Version, Seitentyp, Browserklasse und Request-ID aufnehmen.
- [ ] URLs, Queryparameter und Payloads vor Uebertragung redigieren.
- [ ] Datenschutz und Einwilligungsbedarf fuer zentrale Clientfehler klaeren.
- [ ] Fehlerberichte rate-limitieren und duplizierte Fehler gruppieren.
- [ ] UI zeigt nutzerfreundliche Meldung und Support-ID.
- [ ] Technische Details nur in einem geschuetzten Diagnosemodus anzeigen.
- [ ] Verfahren fuer Support-Screenshots und Logexport dokumentieren.

Abnahmekriterien:

- [ ] Ein Scoreboard-Kommunikationsfehler ist mit Release, Seitentyp und Fehlercode sichtbar.
- [ ] Kein Fehlerbericht enthaelt Passwort, Hash, Token oder vollstaendige Personendaten.
- [ ] Wiederholte identische Fehler eines Hosts erzeugen keinen Meldungssturm.

Abhaengigkeiten: L1, L2, L4 und L5.

### Arbeitspaket L14: Tests, Migration und Rollout

Ziel: Logging-Aenderungen sollen ohne Geheimnisleck, Logverlust oder unkontrolliertes Volumen eingefuehrt werden.

Aufgaben:

- [ ] Testfaelle fuer Redaction aller definierten Geheimnisse erstellen.
- [ ] JSON-Schema fuer operative Logs und Auditlogs testen.
- [ ] Snapshot-Tests fuer wichtige Eventtypen erstellen.
- [ ] Lasttest fuer normales und fehlerhaftes Polling ausfuehren.
- [ ] Logvolumen pro Stunde und pro Veranstaltungstag abschaetzen.
- [ ] Caddy- und journald-Rotation auf PAJ praktisch testen.
- [ ] ScoreLog-Queue bei Google-Ausfall testen.
- [ ] Auditvollstaendigkeit fuer alle Mutationen testen.
- [ ] Suchbarkeit anhand einer Support-ID Ende-zu-Ende pruefen.
- [ ] PAJ mehrere Tage mit Debug-/Info-Auswertung beobachten.
- [ ] Log-Level fuer PK und Live restriktiver konfigurieren.
- [ ] Rollback fuer Logger, Caddy und Metrikexport dokumentieren.
- [ ] Alte unsichere Logstellen erst nach erfolgreicher Migration vollstaendig entfernen.
- [ ] Dokumentation und Betriebs-Runbook aktualisieren.

Abnahmekriterien:

- [ ] Automatische Tests erkennen absichtlich eingebrachte Geheimnisse in Logs.
- [ ] Logvolumen bleibt innerhalb definierter Speichergrenzen.
- [ ] Eine Support-ID verbindet Frontendfehler, Backendrequest und Auditereignis.
- [ ] Rollback und Wiederanlauf wurden auf PAJ getestet.

Abhaengigkeiten: alle jeweils auszurollenden Arbeitspakete.

## 23. Empfohlene Reihenfolge

1. L1 Richtlinie und Datenklassifikation
2. L2 kritische Frontend-Logs bereinigen
3. L3 Backend-Antworten minimieren
4. L4 strukturierten Backend-Logger einfuehren
5. L5 Request- und Correlation-ID
6. L6 Poller-Logging korrigieren
7. L7 WebSocket- und HTTP-Logging
8. L8 ScoreLog-Zuverlaessigkeit
9. L9 fachliches Auditlog
10. L10 Liveness, Readiness und Metriken
11. L11 Caddy und journald
12. L12 Prozesslebenszyklus
13. L13 Frontend-Fehlererfassung
14. L14 Tests und Rollout

Die Aufgaben L2 und L3 haben hoechste Dringlichkeit, weil sie bestehende Offenlegung sensibler Daten reduzieren. Weitere Logs sollten erst nach der Richtlinie und zentralen Redaction hinzugefuegt werden.

## 24. Implementierungsstatus 2026-07-29

Die Abschnitte 1 bis 23 bleiben als historische Analyse und Zielbild erhalten.
Mit Version 4.0.0 wurden sensible Browserlogs entfernt beziehungsweise durch den
statischen Sicherheitscheck abgesichert, allgemeine Personenantworten minimiert
und zentrale Fehlercodes mit korrelierten Support-IDs fuer HTTP- und
WebSocket-Antworten eingefuehrt. Dauerhafte Frontendfehler behalten vorhandene
Support-IDs. Navigator und administrative Oberflaechen zeigen relevante
Verbindungs- und Terminalzustaende; das Scoreboard wertet Connection-, Sync- und
Stale-Zustaende intern aus, besitzt im finalen Bedienkonzept aber keine sichtbaren
Status- oder Court-Quellen-Badges.

Der admin-geschuetzte `/status` liefert Diagnosewerte zu Clients, Polling,
Datenalter, Courtquelle, Monitoren, SheetService und offenen Metadata-Intents.
Unbekannte Fachwrite-Ausgaenge werden akteursbezogen ueber `operationStatus`
abgefragt. WebSocket-Verbindungen erfassen Client-/Seitentyp, letzte Aktivitaet
sowie Close-Code und -Grund.
Liveness und Readiness sind getrennt. Der geordnete Shutdown stoppt Poller und
Timer, lehnt neue Arbeit ab, schliesst WebSockets mit Code 1012 und drainiert
akzeptierte HTTP-/Sheets-Arbeit bis zur Grace-Deadline; eine Ueberschreitung wird
nicht als Erfolg gemeldet.

Das fachliche Spreadsheet-Logging wurde bewusst nicht neu entworfen:

| Writer | Spalte 1 | Spalte 2 | Spalte 3 |
|---|---|---|---|
| `Logging` | `Timestamp` | `Type` | `Message` |
| `ScoreLog` | `Timestamp` | `PlatzNr` | `Score` |

Beide Writer verwenden weiterhin `USER_ENTERED` und besitzen keine EventID-
Spalte und keinen Tabellen-Readback. `ScoreLog` besitzt zudem keine Retry- oder
Write-ahead-Queue, keine SQLite-Persistenz, keine Pendingwerte und keinen
Shutdown-Drain. Seit v4.1.0 dienen erste externe Staende nach Start, Aktivierung
oder Reset nur als ungeloggte Baseline; erst eine spaetere Abweichung eines
aktiven Courts wird fire-and-forget geschrieben. Reset und eingefrorene inaktive
Courts erzeugen keinen ScoreLog-Eintrag. Das SQLite-WAL betrifft ausschliesslich
den Anwendungsstate und ist kein ScoreLog-WAL. Das umfassende Logging-/ScoreLog-
Redesign bleibt einem eigenen spaeteren Branch vorbehalten.

Weiterhin offen sind ein zentraler strukturierter Backend-Logger,
konfigurierbare Loglevel, ein Metrikexport mit Alarmierung und ein eingerichtetes
Caddy-Access-Log. Ebenso fehlen die vollstaendige Logging-/Audit-Richtlinie,
Aufbewahrung und Rotation sowie die praktische Ende-zu-Ende-Suche einer
Support-ID ueber alle Logkanaele. Manuelle Migrations-, Last-, Dauerbetriebs- und
Rollbackpruefungen sind noch nicht abgeschlossen; sie werden in der
[Rollout-Checkliste](../server-configs/ROLLOUT-CHECKLIST.md) gefuehrt. Die
dokumentierten Branch-Pruefungen sind keine Behauptung abschliessender Checks des
offenen Main-Merges.
