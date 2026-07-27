# Kommunikationsanalyse: Frontend, Backend und externe Ressourcen

Stand der Analyse: 27.07.2026

Analysierter Stand: ePiber v3.1.12, Basis-Commit `04131f9`

Vergleichsbasis: fruehere Analyse fuer ePiber v3.0.2

Gegenstand: Frontend, Backend, Caddy, HTTP, WebSocket, Google Sheets,
Court-Score-Quelle, ScoreLog, Navigator und Monitor

Diese Datei beschreibt den zum Analysezeitpunkt im Repository vorhandenen Stand.
Die Verbesserungsvorschlaege sind ein technischer Backlog und wurden nicht
umgesetzt, sofern dies nicht ausdruecklich anders vermerkt ist.

## 1. Untersuchungsrahmen

### 1.1 Gepruefte Quellen

Die Analyse basiert auf dem aktuellen Code und den relevanten versionierten
Dokumentations- und Konfigurationsquellen:

- `Backend/server.js`
- `Backend/config.js`
- `Backend/dataStore.js`
- `Backend/dataPoller.js`
- `Backend/courtPoller.js`
- `Backend/dataProvider.js`
- `Backend/stateStore.js`
- aktuelle kommunikationsrelevante Dateien unter `Frontend/`
- `Project/server-configs/Caddyfile`
- systemd-Vorlagen unter `Project/server-configs/systemd/`
- `Project/software/ARCHITEKTUR.txt`
- `Project/software/ENDPOINTS.txt`
- `Project/software/DATENBANK.txt`
- die vorherige Fassung dieser Analyse fuer v3.0.2

Bei Abweichungen zwischen Dokumentation und Implementierung gilt fuer das
Laufzeitverhalten der aktuelle Code.

### 1.2 Bewusst nicht geprueft

Folgende lokale oder sensible Laufzeitdateien wurden nicht gelesen:

- `Backend/.env`
- Service-Account-JSON-Dateien
- private Schluessel, Tokens oder sonstige Secrets

Damit sind die tatsaechlichen Laufzeitwerte fuer Spreadsheet-ID, Court-URL,
Credential-Datei und Backend-Port nicht verifiziert. Die Dateien unter
`Project/server-configs/` beschreiben den versionierten Sollstand, nicht
zwingend die aktuell unter `/etc` installierte Konfiguration.

### 1.3 Versionsabweichungen in der Dokumentation

Die kanonische Anwendungsversion ist `3.1.12` aus
`Backend/package.json`. Einzelne Dokumente weisen noch einen aelteren Stand aus:

| Quelle | ausgewiesener Stand |
|---|---:|
| `Backend/package.json` | 3.1.12 |
| `Project/software/ARCHITEKTUR.txt` | 3.1.12 |
| `Project/software/ENDPOINTS.txt` | 3.1.11 |
| `Project/server-configs/SERVER-DOKU.txt` | 3.1.11 |
| lokales `Backend/package-lock.json` | Root-Paket 3.0.1 |

Das lokale Lockfile ist nicht die kanonische Versionsquelle und wird laut
Repository-Konfiguration nicht verlaesslich versioniert. Aussagen ueber
Bibliotheksdefaults gelten deshalb nur fuer den untersuchten Checkout.

## 2. Kurzfazit

Die zentrale Kommunikationsarchitektur aus der Analyse fuer v3.0.2 besteht
nahezu unveraendert fort. Die Backend-Kernmodule `dataProvider.js`,
`dataPoller.js`, `courtPoller.js`, `dataStore.js` und `stateStore.js` sind im
Git-Vergleich zwischen v3.0.2 und dem untersuchten Stand funktional unveraendert.

Die Architektur ist fuer eine kleine Anzahl kontrollierter Clients grundsaetzlich
funktionsfaehig. Der zentrale Cache reduziert Google-Sheets-Zugriffe, das
Request/Response-Protokoll korreliert parallele Anfragen und Scoreaenderungen
werden zeitnah gepusht.

Die groessten aktuellen Risiken sind jedoch erheblich:

1. Alle WebSocket-Endpunkte sind ohne serverseitige Authentifizierung und
   Autorisierung erreichbar.
2. Der Endpoint `players` liefert die rohe Personentabelle und damit auch
   Passwort-Hash- und Resetfelder an anonyme Clients.
3. `removeEntryList` kann durch eine veraltete physische Zeilenposition einen
   falschen Datensatz loeschen.
4. Der aktuelle `addMatch`-Frontendaufruf und das Profil-Laden besitzen
   deterministische Frontend-/Backend-Vertragsfehler.
5. Google-Sheets-Writes werden nicht mit dem Cache synchronisiert und sind weder
   serialisiert noch idempotent.
6. Court-Fetches besitzen keinen Anwendungs-Timeout, keinen Abort und keinen
   kontrollierten Fehler-Backoff.
7. WebSocket-Reconnect, Browser-Lifecycle und Stale-Erkennung sind weiterhin
   unzureichend.
8. Navigator und Monitor verwenden globalen Einzelstate und intensives Polling
   ohne Command- oder Monitor-ID.
9. Fehler werden an mehreren Stellen still verschluckt; veraltete Daten bleiben
   fuer Benutzer oft unsichtbar.
10. PAJ und PK uebertragen laut Repository-Sollstand Daten weiterhin
    unverschluesselt ueber HTTP und `ws://`.

Keine der wesentlichen Robustheits-, Push-, Authentifizierungs- oder
Konsistenzmassnahmen aus dem bisherigen K1-K12-Backlog wurde im
Kommunikationskern umgesetzt.

## 3. Aktuelle Gesamtarchitektur

```text
Browser-Dokument
  |-- HTTP: HTML, CSS und JavaScript ueber Caddy
  |-- HTTP: /version, /health, /status, /set-active
  `-- WebSocket: /ws
       |-- Request/Response fuer gecachte Fachdaten
       |-- direkte Google-Sheets-Schreiboperationen
       |-- Navigator- und Scoreboard-State
       |-- JSON-Ping/Pong
       `-- Court-Score-Broadcast

Caddy
  |-- statische Dateien aus Frontend/
  `-- Reverse Proxy fuer /ws und definierte HTTP-Endpunkte

Node.js Backend
  |-- server.js       HTTP und Startup-Orchestrierung
  |-- config.js       Umgebungsvariablen und Pollingkonfiguration
  |-- dataStore.js    In-Memory-Cache fuer Spreadsheet-Daten
  |-- dataPoller.js   periodische Google-Sheets-Reads
  |-- dataProvider.js WebSocket-RPC, State und Google-Sheets-Writes
  |-- stateStore.js   fluechtiger Court-/Navigator-State
  `-- courtPoller.js  externe Court-Quelle, Score-Push und ScoreLog

Externe Ressourcen
  |-- Google Sheets API: Fachdaten, Writes, Logging und ScoreLog
  `-- Court-Score-URL: JSON-Daten fuer aktive Plaetze
```

### 3.1 Systemzuordnung laut Repository-Sollstand

| System | Browser-Origin | Caddy zu Backend | WebSocket |
|---|---|---|---|
| Live | `https://epiber.at` | `localhost:8080` | `wss://epiber.at/ws` |
| PAJ | `http://epiber.at:8081` | `localhost:8083` | `ws://epiber.at:8081/ws` |
| PK | `http://epiber.at:8082` | `localhost:8084` | `ws://epiber.at:8082/ws` |

Referenz: `Project/server-configs/Caddyfile`.

Nur Live verwendet im dokumentierten Sollstand TLS. PAJ und PK uebertragen
WebSocket-Inhalte, Login-Hash und Fachdaten im Klartext.

### 3.2 Verbindungen pro Browserdokument

`Frontend/JS/dataClient.js` verbindet automatisch beim ersten Modulimport.
Innerhalb eines HTML-Dokuments wird das ES-Modul nur einmal ausgewertet, sodass
alle Fachmodule dieses Dokuments denselben Socket teilen.

Unterschiedliche Dokumente besitzen getrennte Verbindungen. Ein Monitor mit
iframe verwendet mindestens zwei WebSockets:

```text
monitor.html                 -> WebSocket 1
iframe mit Anwendungsseite   -> WebSocket 2
```

Auch Seiten ohne unmittelbaren initialen Fachrequest koennen durch den Import
von `modals.js` bereits eine WebSocket-Verbindung aufbauen.

## 4. Browser, Caddy und Transport

### 4.1 Statische Dateien

Caddy liefert statische Dateien aus `Frontend/` aus. Die Vorlage setzt fuer
statische Antworten `Cache-Control: no-cache`. Browser duerfen Inhalte speichern,
muessen sie aber revalidieren. Eine bereits geoeffnete Seite wird dadurch nicht
automatisch aktualisiert.

### 4.2 Versionsabruf

`Frontend/JS/global.js` fragt die Version relativ zum aktuellen Origin ab:

```http
GET /version
```

Damit erreicht der Versionsabruf automatisch das Backend desselben Caddy-Hosts.
Der Request besitzt clientseitig keinen expliziten Timeout; Fehler werden still
ignoriert.

### 4.3 Auswahl des WebSocket-Ziels

Die WebSocket-Adresse kommt aus der lokalen Datei `Frontend/JS/SDK.js` und wird
nicht aus `location.protocol` und `location.host` abgeleitet. Die aktuelle
PAJ-Datei zeigt auf:

```text
ws://epiber.at:8081/ws
```

Risiken:

- Eine alte oder falsch kopierte `SDK.js` kann HTTP und WebSocket mit
  unterschiedlichen Systemen verbinden.
- Eine HTTPS-Seite darf kein unverschluesseltes `ws://` verwenden.
- Eine manuelle Deploymentdatei ist nicht durch den normalen Git-Diff
  abgesichert.

### 4.4 Proxy-Pfade

Laut Caddy-Vorlage werden nur folgende Pfade an das Backend weitergeleitet:

- `/ws`
- `/health`
- `/status`
- `/version`
- `/set-active`

Alle anderen Pfade bedient der statische File-Server.

Der Node-WebSocket-Server selbst prueft den Upgrade-Pfad jedoch nicht. Ist ein
Backend-Port direkt erreichbar, akzeptiert er WebSocket-Upgrades auch auf
anderen Pfaden. `server.listen(PORT)` gibt keinen expliziten Loopback-Host an und
kann deshalb je nach System auf allen Interfaces binden.

## 5. WebSocket-Protokoll

### 5.1 Request und Response

Das Protokoll bildet einen einfachen RPC-Mechanismus ab.

Request:

```json
{
  "type": "request",
  "id": "req-1",
  "endpoint": "matches1",
  "params": {}
}
```

Response:

```json
{
  "type": "response",
  "id": "req-1",
  "endpoint": "matches1",
  "data": {
    "success": true,
    "values": []
  }
}
```

Score-Push:

```json
{
  "type": "scores",
  "data": {
    "courts": []
  }
}
```

### 5.2 Request-Korrelation

Der Client vergibt innerhalb eines Dokuments fortlaufende IDs `req-1`, `req-2`
und so weiter. `pendingRequests` ordnet Antworten den Promises zu. Antworten
duerfen in anderer Reihenfolge eintreffen.

Einschraenkungen:

- IDs sind nicht dokument- oder clientuebergreifend eindeutig.
- Der Server uebernimmt die Request-ID nicht in Logs oder Statusmetadaten.
- Der Client prueft bei Responses nur die ID, nicht zusaetzlich den Endpoint.
- Ein Request ohne ID kann serverseitig trotzdem eine Schreiboperation ausloesen.
- Es gibt keine Operation-ID oder Deduplizierung fuer Writes.
- Mehrere Nachrichten desselben Clients werden serverseitig parallel verarbeitet.

Referenzen: `Frontend/JS/dataClient.js:13-19,125-137` und
`Backend/dataProvider.js:523-546`.

### 5.3 Protokollvalidierung

Es existiert kein zentrales Request- oder Response-Schema. Parameter werden in
den einzelnen Handlern ad hoc geprueft. Bei unbekannten Endpoints liefert der
Server eine Fehlerresponse. Bei ungueltigem JSON oder einem geworfenen
Handlerfehler wird dagegen meist nur serverseitig geloggt; der Client wartet bis
zum Timeout.

Der Handler-Lookup verwendet direkt `endpoints[msg.endpoint]` und prueft nicht,
ob der Name eine eigene Property des Endpoint-Objekts ist. Geerbte Namen wie
`constructor` werden deshalb nicht sauber wie unbekannte Endpoints behandelt.

### 5.4 Fehlender Handshake

Beim Verbindungsaufbau werden insbesondere nicht uebertragen oder geprueft:

- Protokollversion
- Anwendungsversion
- Seitentyp
- Subscription oder Topic
- stabile Geraete-ID
- authentifizierte Sitzung
- Benutzerrolle
- Endpoint-Berechtigung
- erwartetes Deployment

## 6. WebSocket-Lifecycle

### 6.1 Verbindungsaufbau

`dataClient.js` startet `connect()` direkt beim Modulimport. Ein Request wartet
maximal zehn Sekunden auf einen offenen Socket und prueft den Zustand dabei alle
200 Millisekunden.

Viele gleichzeitig wartende Requests besitzen jeweils ein eigenes Intervall und
werden beim Oeffnen des Sockets nahezu gleichzeitig gesendet.

### 6.2 Request-Timeout

Nach dem Senden wartet der Client maximal 15 Sekunden auf eine Response. Der
Timeout entfernt nur den lokalen Pending-Eintrag. Er bricht keine bereits
laufende Server- oder Google-Sheets-Operation ab.

Folge bei Writes:

1. Der Browser meldet einen Timeout.
2. Der Backend-Write kann weiterlaufen und spaeter erfolgreich sein.
3. Der Benutzer wiederholt die Aktion.
4. Append-, Delete- oder Logging-Operationen koennen doppelt ausgefuehrt werden.

### 6.3 Send-Rennen

Zwischen der Pruefung des lokalen `connected`-Flags und `ws.send()` kann der
Socket schliessen. `ws.send()` wird nicht mit einer aktuellen
`readyState`-Pruefung und nicht mit `try/catch` abgesichert. Ein Sendefehler kann
einen verwaisten Pending-Eintrag bis zum Timeout hinterlassen.

### 6.4 Keepalive

Der Server sendet alle 30 Sekunden:

```json
{"type":"ping"}
```

Der normale Client antwortet:

```json
{"type":"pong"}
```

Der Server terminiert Clients, wenn der letzte Pong mehr als 90 Sekunden
zurueckliegt. Da nur alle 30 Sekunden und mit `>` geprueft wird, liegt die
tatsaechliche Erkennung je nach Timerphase ungefaehr zwischen etwas mehr als 90
und bis zu 120 Sekunden.

Die technische Seite `court-score-test.html` verarbeitet weiterhin keine
Ping-Nachrichten und wird im WebSocket-Testmodus nach der Frist terminiert.

### 6.5 Reconnect

Bei einem erkannten `close`-Event:

1. wird `connected` auf `false` gesetzt,
2. wird die Socket-Referenz geloescht,
3. wird nach exakt drei Sekunden erneut verbunden.

Es fehlen:

- exponentieller Backoff
- Zufallsanteil gegen Reconnect-Wellen
- Begrenzung paralleler Connectversuche als explizite Zustandsmaschine
- clientseitiger Stale-Watchdog
- sofortiges Ablehnen aller Pending Requests
- Resync-Hook nach erfolgreichem Reconnect
- Behandlung von `online` und `offline`
- Behandlung von `visibilitychange`
- Behandlung von `pagehide` und `pageshow`
- BFCache-Wiederherstellung
- sichtbarer Verbindungsstatus

Die interne Funktion `disconnect()` ist nicht exportiert. Ihr `close()` wuerde
zudem den normalen Reconnect ausloesen, weil kein Zustand `stopped` existiert.

### 6.6 Broadcast und Backpressure

Court-Scores werden an alle verbundenen WebSocket-Clients gesendet, unabhaengig
davon, ob sie Score-Daten verwenden. Der Client stellt nur einen einzelnen,
ueberschreibbaren Score-Callback bereit.

Nicht vorhanden sind:

- Topic-Subscriptions
- mehrere Listener mit Unsubscribe
- `bufferedAmount`-Kontrolle
- Send-Callbacks
- Queue-Limits fuer langsame Clients
- kontrolliertes Trennen dauerhaft blockierter Clients

Die WS-Bibliothek besitzt in der untersuchten lokalen Installation ein
Standard-Payloadlimit von etwa 100 MiB. Ein kleines, zum Protokoll passendes
Anwendungslimit ist nicht konfiguriert.

## 7. HTTP-Kommunikation

### 7.1 Aktuelle Routen

| Route | Verhalten | aktueller Frontend-Consumer |
|---|---|---|
| `OPTIONS *` | immer 204 | keiner explizit |
| `/health` | kompakter Systemstatus | keiner |
| `/version` | Paketversion | `global.js` |
| `/status` | Clients und Tabellenmetadaten | keiner |
| `POST /set-active` | Court-Polling steuern | keiner |
| Fallback | HTTP 200 mit Text | keiner beabsichtigt |

Referenz: `Backend/server.js:17-86`.

### 7.2 HTTP-Semantik

`/health`, `/version` und `/status` pruefen die HTTP-Methode nicht. Ein Request
mit falscher Methode kann dieselbe Antwort erhalten. Umgekehrt werden Pfade ueber
den exakten Wert von `req.url` verglichen; `/health?x=1` faellt in den
Text-Fallback.

Unbekannte Pfade und viele unpassende Methoden liefern ebenfalls HTTP 200. Das
erschwert Monitoring und Fehlerdiagnose.

### 7.3 CORS

Alle HTTP-Antworten erhalten:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

Diese Header ersetzen keine WebSocket-Origin-Pruefung.

### 7.4 Health und Readiness

`/health` und `/status` liefern immer HTTP 200 und `status: "ok"`. `dataReady`
bedeutet nur, dass jede Tabelle irgendwann erfolgreich in den Cache gesetzt
wurde.

Nicht geprueft werden:

- maximales Tabellenalter
- letzter Pollingfehler
- aktuelle Google-Erreichbarkeit
- Google-Write-Berechtigung
- letzter erfolgreicher Court-Fetch
- Alter der Court-Daten
- Funktionsfaehigkeit kritischer Writes

Ein einmal erreichtes `dataReady: true` wird bei spaeter dauerhaft
fehlschlagenden Polls nicht wieder `false`.

### 7.5 `/set-active`

Der Endpoint sammelt den Requestbody ohne Groessenlimit in einem String. Es gibt
keine Authentifizierung, Content-Type-Pruefung oder Ratebegrenzung. Ein leeres
Objekt wird als Erfolg akzeptiert, obwohl nichts geaendert wird.

`/set-active` aendert den Aktivstatus nur im `courtPoller`. Der WebSocket-Endpoint
`setScoreboardCourt` leitet denselben Pollerzustand dagegen aus `stateStore` ab.
Beide Zustaende koennen deshalb auseinanderlaufen; die naechste Court-State-
Aenderung kann die HTTP-Einstellung wieder ueberschreiben.

## 8. Backend zu Google Sheets

### 8.1 Authentifizierung und Clients

Es existieren drei voneinander getrennte, lazy erzeugte Google-Sheets-Clients:

| Modul | Zweck |
|---|---|
| `dataPoller.js` | periodische Tabellen-Reads |
| `dataProvider.js` | fachliche Writes |
| `courtPoller.js` | ScoreLog-Appends |

Alle verwenden `GoogleAuth` mit dem vollen Spreadsheet-Scope. Der reine Poller
besitzt damit technisch ebenfalls Write-Rechte. Da kein `keyFile` im Code
gesetzt wird, greift die Google-Bibliothek auf Application Default Credentials
zurueck. Die Vorlage empfiehlt dafuer `GOOGLE_APPLICATION_CREDENTIALS`.

Die effektive Credential-Quelle und eine moegliche gemeinsame Nutzung desselben
Service Accounts durch mehrere Deployments wurden nicht geprueft.

### 8.2 Tabellen und Pollingkategorien

| Kategorie | Tabellen | nominales Intervall |
|---|---|---:|
| Fast | `Matches1`, `RL-Platzierung`, `EntryList` | 10 Sekunden |
| Slow | `Personen`, `Bewerb`, `Bewerbsart`, `MatchTyp`, `Navigator` | 30 Sekunden |

Der Grundtakt laeuft alle fuenf Sekunden. Fast-Tabellen werden bei jedem zweiten
akzeptierten Tick gelesen, Slow-Tabellen bei jedem sechsten. Auf dem sechsten
Tick laufen beide Kategorien parallel.

Nominale Last pro Backendprozess:

| Quelle | Reads pro Minute |
|---|---:|
| drei Fast-Tabellen, sechsmal pro Minute | 18 |
| fuenf Slow-Tabellen, zweimal pro Minute | 10 |
| Summe | 28 |
| zusaetzlicher Start-Burst | 8 parallele Reads |

Browser-Polling erhoeht diese Sheets-Read-Rate nicht, weil normale
Frontend-Requests aus dem Cache bedient werden.

### 8.3 Parallelitaet und Zeitverhalten

`isPolling` verhindert, dass ein kompletter Polling-Tick einen noch laufenden
Tick ueberholt. Ein waehrenddessen ausgeloester Fuenf-Sekunden-Tick wird jedoch
vollstaendig verworfen und nicht nachgeholt.

Die Intervalle von 10 und 30 Sekunden sind deshalb nur Nominalwerte. Langsame
Google-Aufrufe oder Bibliotheks-Retries koennen die effektive Datenfrische
deutlich verschlechtern.

Auf einem Slow-Tick koennen acht Tabellenrequests gleichzeitig laufen.

### 8.4 Initialer Load

Beim Start werden alle acht Tabellen mit `Promise.all` parallel geladen. Fehler
werden bereits pro Tabelle abgefangen und als `false` zurueckgegeben. Der
uebergeordnete Initialload gilt deshalb auch dann als abgeschlossen, wenn
einzelne oder alle Tabellen fehlgeschlagen sind.

Erst danach werden WebSocket-Provider, Poller und HTTP-Port gestartet. Der Server
kann somit mit `dataReady: false` erreichbar werden.

### 8.5 Cache-Eigenschaften

`dataStore` speichert rohe 2D-Arrays, letzten erfolgreichen Updatezeitpunkt,
Zeilenanzahl und Pollzaehler pro Tabelle.

Positive Eigenschaft:

- Ein fehlgeschlagener Poll ueberschreibt den letzten erfolgreichen Stand nicht.

Einschraenkungen:

- Es existiert keine TTL.
- Ein alter Cache wird weiterhin mit `success: true` ausgeliefert.
- Ein erfolgreicher leerer API-Response aktualisiert den Zeitstempel.
- Mehrtabellen-Endpunkte koennen Daten unterschiedlicher Revisionen kombinieren.
- Innerhalb eines parallelen Polls koennen bereits neue und noch alte Tabellen
  gleichzeitig sichtbar sein.
- Ein spaeter Pollfehler setzt `dataReady` nicht zurueck.
- Polling-Logs melden teilweise auch bei internen Fehlern pauschal
  "aktualisiert" oder "Initiales Laden abgeschlossen".

### 8.6 Eigene Retry- und Timeoutstrategie

Die Anwendung setzt bei Google-Sheets-Aufrufen weder einen expliziten Timeout
noch ein Abort-Signal. Sie implementiert auch keinen eigenen Quota-Backoff.

Die im untersuchten Checkout installierte Google-/Gaxios-Version wiederholt
bestimmte GET- und PUT-Aufrufe bei Netzwerkfehlern, 408, 429 und 5xx. POST-Appends
und `batchUpdate` werden standardmaessig nicht gleich behandelt. Wegen des nicht
kanonisch versionierten Lockfiles darf dieses Bibliotheksverhalten nicht als
stabile Anwendungsstrategie betrachtet werden.

### 8.7 Quota-Risiko

Ein einzelner Prozess liegt mit nominal 28 Reads pro Minute unter den derzeit
ueblichen Google-Sheets-Grenzen. Falls Live, PAJ und PK dasselbe Google-Projekt
und denselben Service Account verwenden, koennten nominal 84 Reads pro Minute
zusammenkommen. Retries und Start-Bursts kommen hinzu.

Ob diese Bedingung tatsaechlich zutrifft, ist ohne Pruefung der Credentials nicht
verifiziert.

## 9. Google-Sheets-Writes

### 9.1 Inventar

| Ausloeser | Operation | Ziel |
|---|---|---|
| Scoreaenderung | `values.append` | `ScoreLog` |
| `resetPassword` | zwei `values.update` | Passwort und Resetflag in `Personen` |
| `setMatchDate` | `values.update` | MatchDate in `Matches1` |
| `setPreMatchResult` | `values.update` | Ergebnis in `Matches1` |
| `addMatch` | `values.append` | neue Zeile in `Matches1` |
| `addEntryList` | `values.append` | neue Zeile in `EntryList` |
| `removeEntryList` | `spreadsheets.get` und `batchUpdate` | physische Zeile loeschen |
| `withdrawFromRanking` | `values.append` | `Logging` |

Referenzen: `Backend/dataProvider.js:269-448` und
`Backend/courtPoller.js:51-63`.

### 9.2 Fehlende gemeinsame Write-Strategie

Es gibt keine zentrale Write-Queue, keine Operation-ID, keine Deduplizierung,
keine Versionspruefung und keine Transaktion ueber mehrere Google-Aufrufe.
Mehrere Clients koennen dieselben Endpoints parallel ausfuehren.

### 9.3 Cache nach Writes

Kein fachlicher Write aktualisiert oder invalidiert den In-Memory-Cache. Das
Frontend kann unmittelbar nach einer erfolgreichen Operation wieder den alten
Stand erhalten.

Nominale Verzoegerung:

| Daten | Zeit bis zum naechsten regulaeren Poll |
|---|---:|
| Matches und EntryList | bis zu 10 Sekunden |
| Personen und Passwort | bis zu 30 Sekunden |
| bei Pollingfehlern | unbegrenzt |

Eine bereits vor dem Write gestartete Tabellenabfrage kann ausserdem nach dem
Write noch einen alten Snapshot in den Cache uebernehmen.

### 9.4 ID-Erzeugung

`addMatch` und `addEntryList` berechnen die naechste ID als `max(cacheIds) + 1`.
Ohne Lock und sofortige Cacheaktualisierung koennen zwei gleichzeitige oder
schnell aufeinanderfolgende Aufrufe dieselbe ID erzeugen.

### 9.5 Kritisches Delete-Risiko

`removeEntryList` sucht die Kombination aus Bewerb- und Personen-ID im Cache und
verwendet deren Position als physische Zeilennummer im aktuellen Sheet.

Reproduzierbares Fehlerszenario:

1. Der Cache enthaelt Eintrag A in physischer Zeile 10.
2. Ein erster Delete entfernt Zeile 10 im Sheet.
3. Der Cache enthaelt A bis zum naechsten Poll weiterhin in Zeile 10.
4. Ein zweiter Delete findet A erneut im alten Cache.
5. Im Sheet steht inzwischen Eintrag B in der nachgerueckten Zeile 10.
6. Der zweite Delete entfernt B.

Das ist ein Datenintegritaetsrisiko mit potenziellem Falschloeschen.

### 9.6 Passwort-Reset

`resetPassword` schreibt Passwort und Resetflag in zwei getrennten
`values.update`-Aufrufen. Ein Teilerfolg kann das Passwort bereits aendern,
waehrend das Resetflag erhalten bleibt.

Nach Erfolg prueft `verifyUserLogin` bis zum naechsten Personen-Poll weiterhin
den alten Hash aus dem Cache.

## 10. Backend zu externer Court-Quelle

### 10.1 Aktivierung

Polling ist aktiv, wenn Court 1 oder Court 2 aktiv ist. Der Status kann ueber
`POST /set-active` und indirekt ueber `setScoreboardCourt` beeinflusst werden.

### 10.2 Pollingablauf

Ein Poll fuehrt folgende Schritte aus:

1. Aktivstatus pruefen.
2. `fetch(COURT_URL, { cache: "no-store" })` ausfuehren.
3. HTTP-Erfolg pruefen.
4. gesamten Body als Text lesen.
5. `pollCount` erhoehen.
6. Rohtext mit `lastJson` vergleichen.
7. bei Aenderung JSON parsen.
8. Scoreaenderungen ins ScoreLog schreiben.
9. Daten an alle WebSocket-Clients broadcasten.
10. zwei Sekunden nach Abschluss den naechsten Poll planen.

Es handelt sich nicht um einen festen Zwei-Sekunden-Starttakt, sondern um
Requestdauer plus zwei Sekunden.

### 10.3 Timeout und Fehlerverhalten

Es fehlen:

- `AbortController`
- expliziter Fetch-Timeout
- kontrollierter Retry-Backoff
- letzter erfolgreicher Fetchzeitpunkt
- Court-Datenalter
- letzter Fehler im Status

Solange `fetch()` oder `res.text()` nicht abgeschlossen ist, wird kein neuer Poll
geplant. Eine Deaktivierung bricht einen laufenden Request nicht ab.

### 10.4 Mehrfachschleifen bei Reaktivierung

Wird waehrend eines laufenden Fetches deaktiviert und vor dessen Ende erneut
aktiviert, kann sofort ein zweiter Fetch starten. Schliessen beide Requests bei
wieder aktivem Zustand ab, kann jeder einen eigenen Folgetimer planen. Die
einzelne Variable `pollTimerId` kann nur einen davon referenzieren.

Wiederholtes Umschalten kann dadurch mehrere parallele Polling-Schleifen und
hoeheren externen Traffic erzeugen.

### 10.5 Parsing und Strukturvalidierung

`lastJson` wird vor erfolgreichem `JSON.parse()` aktualisiert. Liefert die Quelle
mehrfach denselben ungueltigen Text, wird nur der erste Versuch geparst und
geloggt.

Die Arraystruktur und Court-Objekte werden nicht vollstaendig validiert. Ein
unerwartetes `null`-Element kann in der nicht abgewarteten async-Verarbeitung
eine unbehandelte Promise-Rejection erzeugen. Das Prozessverhalten ist von der
eingesetzten Node-Version abhaengig.

### 10.6 Aenderungserkennung

Der gesamte Rohtext wird verglichen. Fachlich identische Daten mit anderer
Formatierung, Property-Reihenfolge oder irrelevanten Zusatzfeldern koennen einen
neuen Push ausloesen.

Umgekehrt erzeugt eine textuell identische Antwort nach einer Reaktivierung
keinen neuen Push, auch wenn das Frontend einen vollstaendigen Snapshot benoetigt.

## 11. ScoreLog-Kommunikation

Bei einer Scoreaenderung wird fuer Court 1 und Court 2 jeweils ein Scorestring
gebildet und per `values.append` in `ScoreLog` geschrieben.

Aktuelles Verhalten:

- Der erste gueltige Snapshot nach einem Neustart gilt als Aenderung.
- `lastCourtScores` wird vor Abschluss des Appends aktualisiert.
- Appends werden ohne `await` gestartet.
- Zwei Courts koennen parallel schreiben.
- Schnell folgende Aenderungen koennen in anderer Reihenfolge abschliessen.
- Ein fehlgeschlagener Append wird nur geloggt und nicht erneut versucht.
- Derselbe Score wird nicht nachgetragen, weil der Vergleichswert bereits
  aktualisiert wurde.
- Shutdown wartet nicht auf offene Appends.
- Score-Pushes funktionieren unabhaengig vom ScoreLog weiter.

Wenn beide Court-Scores bei jedem Poll wechseln, sind theoretisch ungefaehr 60
ScoreLog-Appends pro Minute moeglich. Fachliche Writes kommen hinzu.

## 12. Aktuelles Endpoint-Inventar

Der Provider enthaelt 30 eigene RPC-Endpunkte.

### 12.1 Aktive Leseendpunkte

| Endpoint | Rueckgabe | aktuelle Hauptconsumer |
|---|---|---|
| `players` | rohe Personentabelle | Modals, Spieler, Matches, Raster, Scoreboard, Navigator, EntryList, Rangliste, RoundRobin |
| `bewerbe` | Bewerbe plus Bewerbsarten | Bewerbe, Matches, Raster, Scoreboard, Navigator, EntryList, Rangliste, RoundRobin |
| `bewerbsart` | rohe Bewerbsarttabelle | Bewerbe, Raster, RoundRobin |
| `matches1` | gefilterte Matches | Matches1, Scoreboard |
| `preMatches` | Alias zu `matches1` | Navigator, Rangliste |
| `matches` | Alias zu `matches1` | Raster, RoundRobin |
| `rlPlatzierung` | Ranglistenplatzierung | EntryList, Rangliste |
| `navigator` | Navigator-Tabelle | Navigator |
| `entryList` | EntryList plus `playerMap` | EntryList |
| `courtScores` | letzter Court-Snapshot | Scoreboard |
| `getScoreboardCourts` | fluechtiger Court-State | Scoreboard, Navigator |
| `getNavigatorTarget` | globales Ziel und Status | Monitor, Navigator |
| `getNavigatorScroll` | globaler Scrollwert | Monitor |
| `readMatchRestrictions` | Schutz- und Sperrzeiten | Rangliste |

Der optionale serverseitige Profilfilter des `navigator`-Endpoints wird vom
aktuellen Frontend nicht genutzt; das Frontend filtert nach Empfang lokal.

Der `entryList`-Endpoint liefert eine zusaetzliche `playerMap`, die der aktuelle
Consumer nicht verwendet.

### 12.2 Aktive State- und Schreibendpunkte

| Endpoint | aktueller Consumer | Wirkung |
|---|---|---|
| `setScoreboardCourt` | Navigator | Court-State und Polleraktivitaet |
| `setNavigatorTarget` | Navigator und Monitor | globales Monitorziel und Ack-Status |
| `setNavigatorScroll` | Navigator und Monitor | globaler Scroll-Einzelwert |
| `verifyUserLogin` | Modals | Hashvergleich gegen Cache |
| `resetPassword` | Modals | zwei Personen-Writes |
| `addMatch` | Modals | Match-Append, aktuell vertraglich gebrochen |
| `addEntryList` | EntryList | Entry-Append |
| `removeEntryList` | EntryList | physisches Delete |
| `withdrawFromRanking` | Modals | nur Audit-Log-Append |

### 12.3 Endpunkte ohne aktuellen Frontend-Consumer

| Endpoint | Funktion |
|---|---|
| `matchTyp` | MatchTyp-Tabelle lesen |
| `roundRobin` | Composite-Snapshot |
| `bracket` | Composite-Snapshot |
| `scoreboard` | Composite-Snapshot |
| `setMatchDate` | Matchdatum per physischer Zeile schreiben |
| `setPreMatchResult` | Ergebnis per physischer Zeile schreiben |
| `getMyChallenges` | offene Challenges fuer User lesen |

Diese Endpunkte bleiben extern erreichbar. Vor einer Entfernung muss geprueft
werden, ob es ausserhalb des Repository-Frontends weitere Consumer gibt.

## 13. Kommunikation pro Seite

| Seite | Initiale Kommunikation | Dauerkommunikation |
|---|---|---|
| `index.html` | `/version`, WebSocket durch Modals, optional `players` | keine regulaere Fachabfrage |
| `players.html` | `/version`, `players` | keine |
| `Matches1.html` | `/version`, Matches, Personen, Bewerbe | keine |
| `Bewerbe.html` | `/version`, Bewerbe, Bewerbsarten | keine |
| `entryList.html` | `/version`, Bewerbe, EntryList, Personen, Rangliste | Writes und unmittelbares Reload |
| `rangliste.html` | `/version`, Bewerbe, Rangliste, Personen, Matches, Restrictions | lokale Zeittimer |
| `RoundRobin.html` | `/version`, Matches, Personen, Bewerbe, Bewerbsarten | keine |
| `bewerbsRaster.html` | `/version`, Bewerbe, Bewerbsarten, Matches, Personen | wirkungsloser Zwei-Sekunden-Timer |
| `scoreboard.html` | Personen, Bewerbe, Court-State, Matches, Court-Score | State 1 s, Matches 5 s, Score-Push |
| `navigator.html` | `/version`, Navigator-Daten | Statuspoll nach Commands und State-Writes |
| `monitor.html` | `/version`, sofortiges Navigatorziel | Ziel 2 s, Scroll 150 ms, iframe-Kommunikation |
| `court-score-test.html` | keine regulaere Backendkonfiguration | CDN-Poll oder eigener WebSocket |

Normale Fachseiten erhalten keine Pushes fuer Tabellenupdates. Ein bereits
geoeffnetes Dokument bleibt auf seinem initialen Stand, bis es selbst erneut
anfragt oder neu geladen wird.

### 13.1 Frontend-Retryhilfe

`callWithRetry()` fuehrt fuer ausgewaehlte initiale Read-Aufrufe bis zu drei
Versuche mit jeweils zehn Sekunden fester Pause aus. Es gibt keinen Jitter.

Die Hilfe wird nicht einheitlich verwendet. Insbesondere Scoreboard, Monitor,
Navigator, Spieleransicht, Rangliste, Login und Writes besitzen keine
vergleichbare Strategie.

Ein alter oder leerer Cache antwortet meist mit `success: true`; dieser Zustand
loest keinen Retry aus.

## 14. Scoreboard-Kommunikation

### 14.1 Initialisierung

Das Scoreboard laedt sequenziell:

1. Personen
2. Bewerbe
3. Scoreboard-Court-State
4. Matches
5. letzten bekannten Court-Score

Personen und Bewerbe werden nicht parallel geladen. Ein Timeout in einer fruehen
Phase verzoegert alle folgenden Schritte.

### 14.2 Laufzeitkommunikation

| Information | Intervall oder Mechanismus |
|---|---|
| Court-Zuordnung, Spieler, Bewerb und Aktivstatus | 1 Sekunde nach Requestende |
| naechste und letzte Matches | 5 Sekunden nach Requestende |
| Court-Punkte | WebSocket-Push |

Die rekursiven `setTimeout`-Schleifen verhindern beim Scoreboard eine
Selbstueberlappung.

Pro Scoreboard entstehen nominal etwa 72 WebSocket-RPCs pro Minute. Da der
Backend-Matchcache nur nominal alle zehn Sekunden aktualisiert wird, liefert das
Fuenf-Sekunden-Matchpolling oft denselben Snapshot mehrfach.

### 14.3 Reconnect und Snapshot

Ein neuer WebSocket-Client erhaelt den letzten bekannten Score sofort beim
Connect. Das Scoreboard fragt `courtScores` zusaetzlich einmalig beim Start ab.

Es gibt aber keinen atomaren Snapshot aus:

- Court-Zuordnung
- Aktivstatus
- Court-Score
- Matches
- gemeinsamer Revision oder Zeitstempel

Nach Reconnect existiert kein expliziter Zustand "verbunden, aber noch nicht
synchronisiert".

### 14.4 Stale-Verhalten

Nach der Initialabfrage existiert kein periodischer Score-Fallback. Bleibt ein
Socket scheinbar offen, transportiert aber keine neuen Pushes, kann ein alter
Score unbegrenzt sichtbar bleiben.

Das Scoreboard speichert und zeigt weder den Zeitpunkt des letzten Score-Pushes
noch das Alter der Daten an. Kommunikationsfehler werden in mehreren Catch-
Bloecken still ignoriert. Der Loader wird auch nach fehlgeschlagenen Requests
entfernt und die Seite als geladen angezeigt.

### 14.5 Aktivitaetswechsel

Beim Deaktivieren eines Courts werden bestehende Punkte im DOM nicht sicher
geloescht. Wird derselbe Court spaeter reaktiviert und liefert die externe Quelle
textuell denselben Stand, entsteht kein neuer Push. Alte Werte koennen bis zur
naechsten Scoreaenderung sichtbar bleiben.

## 15. Navigator und Monitor

### 15.1 Zielsteuerung

Der Navigator setzt ein globales Ziel mit `setNavigatorTarget`. Danach fragt er
alle 150 Millisekunden ab, ob der globale Status `loaded` erreicht wurde. Der
Statuspoll besitzt keinen fachlichen Timeout.

Der Monitor fragt alle zwei Sekunden nach dem Ziel. Bei einem neuen Pfad setzt er
die iframe-URL und fuegt `monitor=1` sowie einen Cache-Busting-Zeitstempel an.

Nach dem iframe-`load`-Event bestaetigt der Monitor den aktuell vorgemerkten Pfad
als geladen.

### 15.2 Pollinglast

| Poll | Frequenz pro Monitor |
|---|---:|
| Ziel | 30 Requests pro Minute |
| Scroll | 400 Requests pro Minute |
| Summe | etwa 430 Requests pro Minute |

Navigator-Statuspolls kommen waehrend eines Zielwechsels zusaetzlich hinzu.

Die Polls verwenden `setInterval(async ...)`. Langsame Requests koennen sich
ueberlappen und in anderer Reihenfolge antworten.

### 15.3 Zielrennen

Moeglicher Ablauf:

1. Poll A liest Ziel A.
2. Poll B liest spaeter Ziel B und antwortet zuerst.
3. Der Monitor laedt B.
4. Die verspaetete Antwort A trifft ein.
5. Der Monitor laedt wieder A.

Es gibt keine Sequenznummer, Command-ID oder Pruefung gegen den Requestbeginn.

### 15.4 Falsches Acknowledgement

Der iframe-Load-Handler bestaetigt den aktuell in `pendingTarget` stehenden Pfad.
Ein verspaetetes Load-Event fuer A kann deshalb das inzwischen vorgemerkte Ziel B
als `loaded` bestaetigen.

Der Navigator prueft nur den globalen Status, nicht Pfad oder Command-ID.

### 15.5 Scroll-State

Der Scroll-State besteht aus einem globalen `{ amount, ts }`.

Folgen:

- Schnelle Writes ueberschreiben einander.
- Mehrere Monitore konkurrieren um denselben Wert.
- Ein Monitor liest einen Befehl und setzt danach `amount` auf null.
- Trifft zwischen Read und Reset ein neuer Befehl ein, kann der Reset den neuen
  Befehl loeschen.
- Der Timestamp verhindert keine nicht-atomaren Read/Reset-Rennen.

### 15.6 iframe-Sicherheit

Der Zielpfad kommt ungeprueft aus dem Backend-State und wird direkt als
`iframe.src` verwendet. Das iframe besitzt kein `sandbox`-Attribut. Jeder
WebSocket-Client kann den globalen Zielstate setzen.

Es fehlen:

- Allowlist lokaler Seiten
- Parameter-Validierung
- Monitor-ID
- Command-ID
- Lade-Timeout
- explizites `failed`-Acknowledgement
- Korrelation von Load-Event und tatsaechlichem Command

## 16. Aktuelle Frontend-/Backend-Vertragsfehler

### 16.1 `addMatch`

Das Backend erwartet:

```js
{ bewerbId, p1id, p2id, p3id, p4id, forderungDate }
```

Beide aktuellen Frontend-Pfade senden dagegen unter anderem:

```js
{ player1Id, player3Id }
```

Serverseitig bleiben `p1id` und `p3id` leer. Der Endpoint antwortet
deterministisch mit `Spieler erforderlich`, bevor Google Sheets aufgerufen wird.

Referenzen: `Backend/dataProvider.js:347-350` und
`Frontend/JS/modals.js:557-564,686-703`.

### 16.2 Profil-Laden

Der Backend-Endpoint `players` liefert:

```js
{ success: true, values: [...] }
```

`openProfileModal` erwartet dagegen:

```js
{ success: true, players: [...] }
```

`players` ist dort immer `undefined`; der aktuelle Profilpfad bricht mit
"Spieler-Liste konnte nicht geladen werden" ab.

Referenzen: `Backend/dataProvider.js:103-105` und
`Frontend/JS/modals.js:486-505`.

### 16.3 Fehlende Vertragstests

Beide Fehler zeigen, dass Endpointnamen und Parameter zwar dokumentiert, aber
nicht automatisiert zwischen Frontend und Backend geprueft werden. Es existieren
keine Integrationstests fuer Request- und Response-Schemas.

## 17. Authentifizierung und Autorisierung

### 17.1 Loginablauf

1. Das Frontend bildet einen SHA-256-Hash des Passworts.
2. Auf sicheren Origins wird Web Crypto verwendet.
3. Auf HTTP-Testsystemen steht seit v3.1.12 ein JavaScript-Fallback bereit.
4. `verifyUserLogin` vergleicht E-Mail und Hash mit dem Personen-Cache.
5. Bei Erfolg speichert das Frontend Loginstatus, Benutzer-ID, Name und E-Mail in
   `localStorage`.

Es entstehen kein Server-Token, keine Session und keine serverseitige Rolle.

### 17.2 Replayfaehiger Hash

Der gespeicherte Hash wird direkt als Login-Nachweis akzeptiert. Wer den Hash
kennt, benoetigt das Klartextpasswort fuer denselben Endpoint nicht mehr.

Auf PAJ und PK wird dieser Nachweis laut Sollkonfiguration unverschluesselt ueber
`ws://` uebertragen. Das Frontend protokolliert E-Mail und Hash zudem aktuell in
der Browserkonsole.

### 17.3 Rohe Personentabelle

`players` liefert `dataStore.get("players")` unveraendert. Die dokumentierte
Personentabelle enthaelt unter anderem:

- ID
- Vorname und Nachname
- E-Mail
- Passwort-Hash
- Kennwort-vergessen-Flag
- Telefonnummer
- Geschlecht
- Aktivstatus

Auch Composite-Endpunkte koennen die vollstaendigen Personendaten mitliefern.
Der Endpoint ist anonym erreichbar. `playerList.js` loggt die empfangene Tabelle
zusaetzlich vollstaendig in die Browserkonsole.

### 17.4 Keine Endpoint-Berechtigungen

Ein erfolgreicher Login veraendert nur die Frontend-UI. Der Backend-Clientstate
enthaelt keine Benutzeridentitaet oder Rolle. Jeder verbundene Client kann direkt
aufrufen:

- Passwort-Reset
- Match-Writes
- EntryList-Adds und -Deletes
- Navigator-Steuerung
- Court-State und Court-Aktivierung
- Audit-Logging mit frei gesetzter User-ID

Die kritischste Sicherheitsfeststellung ist deshalb nicht nur ein schwaches
Loginverfahren, sondern das vollstaendige Fehlen serverseitiger Zugriffskontrolle.

## 18. Weitere Sicherheitsrisiken

### 18.1 WebSocket-Handshake

Der WebSocket-Server wird ohne Pfad-, Origin- oder Authentifizierungspruefung
erstellt. Es fehlen ausserdem Verbindungs-, Nachrichten- und kleine
Payloadlimits.

### 18.2 Ratebegrenzung

Es gibt keine Rate-Limits fuer:

- Verbindungsaufbau
- Loginversuche
- Passwort-Reset
- State-Writes
- fachliche Writes
- parallele Requests pro Client
- Google-Sheets-ausloesende Endpoints

### 18.3 DOM-Injektion

Sheet- und State-Werte werden an mehreren Stellen ueber Template-Strings in
`innerHTML` eingesetzt, beispielsweise in Spieler-, Match-, Bewerb-, EntryList-,
Raster-, RoundRobin-, Scoreboard- und Profilansichten.

Besonders kritisch ist die Kombination aus:

- anonym erreichbaren State- oder Write-Endpunkten,
- ungeprueften Strings,
- `innerHTML`,
- Loginstatus in `localStorage`.

Auch `setScoreboardCourt` uebernimmt Spielernamen ungeprueft. Bestimmte
Scoreboard-Pfade rendern diese Werte als HTML.

### 18.4 Oeffentliche Diagnoseendpunkte

`/status` gibt ohne Authentifizierung unter anderem Clientanzahl,
Verbindungszeitpunkte, letzten Endpoint sowie Tabellenzeitpunkte und
Zeilenanzahlen aus. Diese Daten sind fuer Diagnose nuetzlich, sollten aber nicht
ungeprueft oeffentlich sein.

## 19. Fehlerbehandlung und Benutzerfeedback

### 19.1 Stille Fehler

Mehrere Module behandeln Kommunikationsfehler nur mit leerem Catch, Konsolenlog
oder leeren Ersatzdaten. Besonders relevant:

- Scoreboard behaelt alte Daten ohne Warnung.
- Rangliste kann fehlende Restrictions als leere Restriction-Maps behandeln.
- Monitor behaelt bei Fehlern das alte iframe.
- `/version`-Fehler bleiben unsichtbar.
- Backend-Handlerfehler fuehren oft nur zu einem Clienttimeout.

### 19.2 Fehleroverlay-Rennen

`showErrorOverlay()` ruft zuerst `hideLoadingOverlay()` auf. Diese Funktion
startet einen 400-ms-Timer, der spaeter die dann aktuelle globale Variable
`activeOverlay` entfernt. Direkt danach setzt `showErrorOverlay()` dieselbe
Variable auf das neue Fehleroverlay.

Der alte Timer entfernt dadurch typischerweise das gerade neu erzeugte
Fehleroverlay. Benutzer sehen den Fehler nur sehr kurz oder gar nicht.

Referenz: `Frontend/JS/loadingHelper.js:55-86`.

### 19.3 Haengende Ladeoverlays

Mehrere Seiten kehren in fachlich leeren Erfolgsfaellen vor dem Aufruf von
`hideLoadingOverlay()` zurueck. Das kann unter anderem EntryList, Bewerbe,
Turnierraster und RoundRobin betreffen.

### 19.4 Uneinheitliche Fehlervertraege

Transportfehler lehnen ein Promise ab. Fachliche Fehler werden dagegen als
`{ success: false }` erfolgreich transportiert. Direkte Aufrufer muessen beide
Fehlerarten unterschiedlich behandeln. Diese Trennung wird nicht konsequent
eingehalten.

## 20. Beobachtbarkeit

### 20.1 Vorhandene Daten

Das Backend fuehrt pro Client eine laufende numerische ID und speichert:

- Verbindungszeitpunkt
- letzten Endpoint und Zeitpunkt
- letzten Pong intern

Der Status enthaelt ausserdem Tabellenmetadaten und Pollzaehler.

### 20.2 Fehlende Daten

Nicht vorhanden oder nicht ausgegeben werden:

- global eindeutige Request-ID
- Operation-ID fuer Writes
- Seitentyp
- Deployment-/Protokollversion des Clients
- Remote-IP und Origin in kontrollierter Diagnoseform
- Requestdauer
- Erfolgs-/Fehlerzaehler pro Endpoint
- Clienttimeouts und Reconnects
- Close-Code und Close-Grund
- letzter Pong in `/status`
- WebSocket-Puffer oder langsame Clients
- letzter erfolgreicher Court-Fetch
- Court-Datenalter
- letzter Google-Fehler pro Tabelle
- Quota- oder Retryzaehler
- offene Writes beim Shutdown

### 20.3 Logging

Aktuell werden vor allem Start, Polling, einzelne externe Fehler,
Client-Connect/Disconnect und fehlende Pongs geloggt. Logs sind nicht
strukturiert und nicht ueber Request-IDs mit Frontendfehlern korrelierbar.

Erfolgreiche oder fehlgeschlagene fachliche Writes werden nicht einheitlich mit
Operation, Benutzer, Dauer und Ergebnis protokolliert.

## 21. Startup, State und Shutdown

### 21.1 Startup

Die systemd-Vorlage verwendet `Type=simple`, `Restart=always` und
`RestartSec=5`. systemd betrachtet den Prozess frueh als gestartet, waehrend der
HTTP-Port erst nach dem initialen Tabellenload geoeffnet wird. Caddy kann in
dieser Phase einen Proxyfehler liefern.

Fehler einzelner Tabellen verhindern den Portstart nicht.

### 21.2 Fluechtiger State

Folgende Daten liegen nur im Prozessspeicher:

- Court-Zuordnung
- Court-Aktivstatus
- Navigator-Ziel
- Navigator-Status
- Scrollwert und Zeitstempel
- letzter Court-Snapshot
- Cache aller Spreadsheet-Tabellen

Bei einem Neustart gehen diese Daten verloren oder werden neu geladen. Beide
Courts starten inaktiv.

### 21.3 Shutdown

Es gibt keine explizite Behandlung von `SIGTERM` oder `SIGINT`.

Nicht vorhanden sind:

- `server.close()` und kontrolliertes HTTP-Drain
- `wss.close()` mit Anwendungs-Close-Code
- Ablehnung neuer Requests waehrend Shutdown
- Stoppen des Ping-Timers
- allgemeiner Court-Poller-Shutdown
- Aufruf des vorhandenen `dataPoller.stop()`
- Abbruch laufender Fetches
- Abschluss oder Abbruch laufender Google-Writes
- Drain der ScoreLog-Appends

Ein Deploy trennt Clients deshalb ohne kontrollierten Anwendungsgrund und kann
fluechtige Writes verlieren.

## 22. Was sich seit v3.0.2 geaendert hat

### 22.1 Geaendert

1. Die Paketversion wurde auf `3.1.12` angehoben.
2. Alte Seiten `matches.html` und `preMatches.html` sowie ihre Frontendmodule
   wurden entfernt.
3. Die Aliase `matches` und `preMatches` bleiben fuer andere aktuelle Seiten
   erhalten.
4. `setMatchDate` und `setPreMatchResult` besitzen keinen aktuellen
   Repository-Frontendconsumer mehr.
5. Das WebSocket-Konfigurationssymbol wurde zu `BACKEND_WS_URL` umbenannt.
6. Die SDK-Beispieldatei verwendet keinen konkreten Deploymentwert mehr.
7. Ein JavaScript-SHA-256-Fallback erlaubt Login und Reset auf HTTP-Testsystemen.
8. Credential-Hygiene und `.gitignore` wurden verbessert.
9. Caddy- und systemd-Vorlagen wurden versioniert.

### 22.2 Unveraendert

1. Google-Sheets-Cache mit 10-/30-Sekunden-Polling.
2. Kein sofortiger Cacheabgleich nach Writes.
3. Raw-Textvergleich fuer Court-Daten.
4. Court-Fetch ohne Anwendungs-Timeout und Abort.
5. Score-Broadcast an alle Clients.
6. JSON-Ping/Pong mit 30-/90-Sekunden-Werten.
7. Fester Drei-Sekunden-Reconnect.
8. Keine Client-Zustandsmaschine oder Stale-Erkennung.
9. Kein Browser-Lifecycle- oder BFCache-Handling.
10. Keine Subscriptions.
11. Globaler Navigator-/Scroll-State ohne IDs.
12. Keine Authentifizierung oder Endpointautorisierung.
13. Keine Origin- oder Backend-Pfadpruefung fuer WebSockets.
14. Kein Graceful Shutdown.

### 22.3 Neue oder jetzt konkret belegte Fehler

Die folgenden Punkte waren in der frueheren Analyse nicht oder nicht so konkret
erfasst:

- gebrochener `addMatch`-Requestvertrag
- gebrochener Profil-Responsevertrag
- reproduzierbares Falschloeschen bei wiederholtem `removeEntryList`
- Court-Poller-Mehrfachschleifen nach schnellem Reaktivieren
- `lastJson` wird vor erfolgreichem Parse gesetzt
- moegliche unbehandelte Promise-Rejection bei ungueltiger Court-Struktur
- Fehleroverlay wird durch einen alten Timer wieder entfernt
- `/set-active` und `stateStore` koennen widerspruechliche Aktivzustaende halten
- lokale Dependencydefaults sind wegen des Lockfile-Zustands nicht reproduzierbar

## 23. Positive Eigenschaften des aktuellen Systems

1. Der zentrale Cache entkoppelt normale Browserreads von Google-Sheets-Reads.
2. Ein Pollfehler loescht den letzten erfolgreichen Tabellenstand nicht.
3. Fast- und Slow-Kategorien reduzieren unnoetige Stammdatenabfragen.
4. Polling-Ticks ueberholen einander regulaer nicht.
5. Initiale Tabellenreads laufen parallel.
6. Request-IDs erlauben parallele RPCs und Out-of-order-Responses.
7. Connect-Warten und Response-Warten besitzen clientseitige Obergrenzen.
8. Ping/Pong entfernt viele tote Verbindungen.
9. Neue WebSocket-Clients erhalten den letzten Court-Snapshot sofort.
10. Score-Pushes werden nicht von langsamen ScoreLog-Appends blockiert.
11. Tabellenmetadaten und Clienttracking bilden eine brauchbare Basis fuer
    bessere Diagnose.
12. Live ist im dokumentierten Sollstand ueber HTTPS/WSS abgesichert.

Diese Staerken sollten bei einem Umbau erhalten bleiben.

## 24. Priorisiertes Risikoregister

### 24.1 Kritisch

| Risiko | Auswirkung |
|---|---|
| keine Backend-Authentifizierung oder Autorisierung | anonyme Reads, Writes und State-Manipulation |
| rohe Personentabelle inklusive Hashfeldern | Offenlegung replayfaehiger Login-Nachweise und Personendaten |
| physisches Delete aus veraltetem Cache | falscher EntryList-Datensatz kann geloescht werden |
| ungeprueftes HTML und manipulierbarer Monitorstate | DOM-Injektion und fremde Monitorziele |

### 24.2 Hoch

| Risiko | Auswirkung |
|---|---|
| gebrochener `addMatch`-Vertrag | Challenge-/Match-Erstellung funktioniert nicht |
| gebrochener Profilvertrag | Profil kann nicht geladen werden |
| keine Write-Serialisierung oder Idempotenz | doppelte IDs und doppelte Operationen |
| Clienttimeout ohne Backendabbruch | unklarer Write-Ausgang und gefaehrliche Wiederholung |
| Court-Fetch ohne Timeout/Abort | Polling kann aus Anwendungssicht blockieren |
| Court-Poller-Mehrfachschleifen | parallele Fetches und erhoehte Last |
| keine Rate- und angemessenen Payloadlimits | DoS- und Quota-Risiko |
| HTTP/WS auf PAJ und PK | Klartexttransport sensibler Daten |
| keine echte Readiness und kein Shutdown | unklare Deploy- und Ausfallzustaende |

### 24.3 Mittel

| Risiko | Auswirkung |
|---|---|
| veralteter Cache nach Writes | UI zeigt widerspruechliche Ergebnisse |
| Fire-and-forget ScoreLog | Luecken und falsche Reihenfolge im Log |
| kein Stale-Watchdog | eingefrorene Anzeige bleibt unbemerkt |
| intensives Navigator-/Monitor-Polling | Last, Ueberlappung und Races |
| globaler Scroll-Einzelwert | verlorene Commands |
| stille Catch-Bloecke | alte Daten wirken gueltig |
| kein atomarer Scoreboard-Snapshot | inkonsistente Teilstaende nach Reconnect |
| oeffentlicher `/status` | unnoetige Betriebsinformationen |

### 24.4 Niedrig

| Risiko | Auswirkung |
|---|---|
| Dispatcher ohne Own-Property-Pruefung | unerwartete Behandlung geerbter Namen |
| Spaltenberechnung nur fuer A-Z | kuenftige Writes ab Spalte AA waeren falsch |
| leerer Raster-Refresh-Timer | unnoetiger lokaler Timer |
| uneinheitliche Versionsmetadaten | Diagnose- und Deploymentverwirrung |

## 25. Zielbild

Das empfohlene Zielbild behaelt WebSocket-RPC und den zentralen Cache bei,
ergaenzt sie aber um klare Grenzen:

```text
Browser
  |-- HTTPS/WSS only
  |-- authentifizierte Sitzung oder kurzlebiges Token
  |-- versionierter Protokoll-Handshake
  |-- typisierte Request/Response-Schemas
  |-- Topic-Subscriptions und Resync-Snapshots
  `-- sichtbarer Connection- und Datenalterstatus

Caddy
  |-- statische Dateien
  |-- geschuetzte Diagnosepfade
  `-- Proxy nur auf lokalen Backend-Socket

Backend
  |-- Authentifizierung und Endpoint-Policies
  |-- validierter RPC-Dispatcher mit Limits
  |-- Cache mit Revision und Datenalter
  |-- serialisierte, idempotente Writes anhand stabiler IDs
  |-- Events/Invalidierungen statt intensivem Frontend-Polling
  |-- externe Calls mit Timeout, Abort und Backoff
  |-- Readiness, Metriken und Graceful Shutdown
  `-- kontrollierte State-Persistenz nach fachlicher Entscheidung
```

## 26. Detaillierter Umsetzungsbacklog

Die Arbeitspakete sind nach aktuellem Risiko neu geordnet. Sicherheits- und
Datenintegritaetsprobleme stehen vor Komfort- und Architekturverbesserungen.

### K0: Aktuelle Funktions- und Integritaetsfehler beheben

Ziel: Bekannte deterministische Fehler und das Falschloeschrisiko zuerst
beseitigen.

Aufgaben:

- [ ] Einheitliches `addMatch`-Requestschema festlegen.
- [ ] Beide Frontend-Aufrufer und Backend-Handler auf dasselbe Schema bringen.
- [ ] Profil-Endpoint und Profil-Frontend auf dasselbe Responseformat bringen.
- [ ] `removeEntryList` nicht mehr anhand einer gecachten physischen Position
      loeschen.
- [ ] Aktuelle Zeile unmittelbar vor dem Delete anhand stabiler IDs aufloesen.
- [ ] Zweiten Delete derselben Operation idempotent beantworten.
- [ ] Vertragstests fuer `addMatch`, Profil und EntryList-Delete ergaenzen.
- [ ] Fehleroverlay-Timer auf eine lokale Elementreferenz umstellen.
- [ ] Ladeoverlays in `finally` oder einem gemeinsamen Abschluss entfernen.

Abnahmekriterien:

- [ ] Beide Match-Erstellungspfade erzeugen mit gueltigen Parametern einen
      eindeutigen Datensatz.
- [ ] Das Profil laedt den aktuellen Benutzer mit dem dokumentierten Schema.
- [ ] Ein wiederholter Delete kann keinen benachbarten Datensatz entfernen.
- [ ] Ein Fehleroverlay bleibt sichtbar, bis es definiert geschlossen wird.

Abhaengigkeiten: keine.

### K1: Personendaten, Authentifizierung und Transport absichern

Ziel: Anonyme Clients duerfen keine sensiblen Daten oder Schreiboperationen
erreichen.

Aufgaben:

- [ ] Rollenmodell fuer oeffentliche Anzeige, Spieler, Navigator und
      Administration definieren.
- [ ] Serverseitige Sitzung oder kurzlebiges signiertes Token einfuehren.
- [ ] WebSocket-Handshake authentifizieren.
- [ ] Berechtigungen pro Endpoint serverseitig pruefen.
- [ ] `players` in eine minimale oeffentliche Projektion und geschuetzte
      Profildaten aufteilen.
- [ ] Passwort-Hash, Resetflag, E-Mail und Telefon nie allgemein ausliefern.
- [ ] Passwort-Hash und E-Mail aus Browserlogs entfernen.
- [ ] Passwort-Reset mit einmaligem, zeitlich begrenztem Nachweis absichern.
- [ ] PAJ und PK auf HTTPS/WSS umstellen.
- [ ] WebSocket-Origin gegen eine Allowlist pruefen.
- [ ] Backend-WebSocket-Pfad auf `/ws` begrenzen.
- [ ] Backend nur an Loopback oder Unix-Socket binden.
- [ ] `/status` und `/set-active` authentifizieren oder netzseitig sperren.

Abnahmekriterien:

- [ ] Ein anonymer Client kann keine Schreiboperation ausfuehren.
- [ ] Ein Anzeigeclient erhaelt keine Passwort-, Reset-, E-Mail- oder
      Telefondaten.
- [ ] Ein kopierter localStorage-Loginstatus erzeugt keine Backendberechtigung.
- [ ] Fremde Origins und falsche Upgrade-Pfade werden abgewiesen.
- [ ] Alle Systeme verwenden verschluesselte Browserkommunikation.

Abhaengigkeiten: fachliche Rollenentscheidung.

### K2: Protokoll und Endpointvertraege definieren

Ziel: Frontend und Backend teilen maschinenpruefbare Request- und
Responsevertraege.

Aufgaben:

- [ ] Protokollversion in Handshake, Request und Diagnose aufnehmen.
- [ ] Zentrales Schema fuer jeden Endpoint definieren.
- [ ] Pflichtfelder, Typen, Laengen und erlaubte Werte validieren.
- [ ] Einheitliches Fehlerformat mit Code, Nachricht und Support-ID verwenden.
- [ ] Own-Property- und Funktionspruefung im Dispatcher einfuehren.
- [ ] Request-ID serverseitig uebernehmen und loggen.
- [ ] Unbekanntes JSON, Handlerfehler und Validierungsfehler immer beantworten.
- [ ] Nicht verwendete Endpoints nach externer Consumerpruefung entfernen oder
      sperren.
- [ ] Spaltenadressierung fuer Werte jenseits von Z korrekt implementieren.

Abnahmekriterien:

- [ ] Jeder dokumentierte Endpoint besitzt automatisierte Contract-Tests.
- [ ] Ungueltige Nachrichten loesen keine fachliche Operation aus.
- [ ] Jeder akzeptierte Request erhaelt genau eine korrelierte Response.
- [ ] Frontend- und Backend-Versionen erkennen inkompatible Protokolle.

Abhaengigkeiten: K0; Authfelder bauen auf K1 auf.

### K3: Schreibkonsistenz und Cache-Synchronisation

Ziel: Writes duerfen keine falschen, doppelten oder unsichtbaren Daten erzeugen.

Aufgaben:

- [ ] Alle Writes auf stabile fachliche IDs statt Client-Zeilennummern umstellen.
- [ ] Zielzeile unmittelbar vor dem Write serverseitig neu aufloesen.
- [ ] Add- und Delete-Operationen pro Tabelle serialisieren.
- [ ] Operation-ID fuer idempotente Wiederholung einfuehren.
- [ ] Serverseitige Deduplizierung mit begrenzter Aufbewahrungszeit umsetzen.
- [ ] Optimistic Locking oder Datensatzrevision definieren.
- [ ] Konflikte mit eigenem Fehlercode melden.
- [ ] Erfolgreiche Writes sofort im Cache nachvollziehen oder gezielt repollen.
- [ ] Alte, vor dem Write gestartete Pollergebnisse nicht ueber neuere Revisionen
      schreiben lassen.
- [ ] Passwort und Resetflag atomar oder kontrolliert kompensierbar schreiben.
- [ ] Google-Aufrufe mit einer definierten maximalen Laufzeit versehen.
- [ ] Unklaren Ausgang nach Clienttimeout explizit kommunizieren.

Abnahmekriterien:

- [ ] Zwei parallele Adds erzeugen unterschiedliche IDs.
- [ ] Wiederholung derselben Operation-ID erzeugt keine zweite Aenderung.
- [ ] Direkt nach erfolgreichem Write liefert ein Read den neuen Stand.
- [ ] Ein veralteter Client erhaelt einen Konflikt statt fremde Daten zu
      ueberschreiben oder zu loeschen.
- [ ] Ein Timeout besitzt einen eindeutig diagnostizierbaren Operationsstatus.

Abhaengigkeiten: K2.

### K4: Ausgangszustand messbar machen

Ziel: Verbindungs-, Daten- und externe Ressourcenfehler muessen vor groesseren
Umbauten sichtbar sein.

Aufgaben:

- [ ] Zufallsgestuetzte Client-ID pro Dokument erzeugen.
- [ ] Seitentyp und Protokollversion beim Handshake melden.
- [ ] Zeitpunkt der letzten Servernachricht im Client speichern.
- [ ] letzten Ping und Pong erfassen.
- [ ] Reconnect-Versuche zaehlen.
- [ ] Close-Code und Close-Grund erfassen.
- [ ] Requestdauer und Ergebnis pro Endpoint messen.
- [ ] Tabellenalter und letzten Pollfehler ausgeben.
- [ ] letzten erfolgreichen Court-Fetch und Court-Datenalter ausgeben.
- [ ] offene Google-Writes und ScoreLog-Queue messen.
- [ ] Diagnosemodus fuer PAJ ohne sensible Payloads bereitstellen.
- [ ] strukturierte Logs mit Request- und Operation-ID verwenden.

Abnahmekriterien:

- [ ] Ein eingefrorener Scoreboard-Client ist von einem gesunden Client
      unterscheidbar.
- [ ] Support kann eine Frontend-Support-ID einem Servervorgang zuordnen.
- [ ] Datenalter ist fuer jede kritische Quelle erkennbar.
- [ ] Logs enthalten keine Hashes, Secrets oder vollstaendigen Personendaten.

Abhaengigkeiten: K1 fuer datenschutzkonforme Diagnose, sonst keine.

### K5: WebSocket-Client als Zustandsmaschine

Ziel: Der Verbindungszustand soll explizit und reproduzierbar sein.

Vorgeschlagene Zustaende:

```text
idle -> connecting -> connected -> stale -> backoff
                       |             |
                       v             v
                     offline       stopped
```

Aufgaben:

- [ ] Erlaubte Zustandsuebergaenge zentral implementieren.
- [ ] Mehrfaches paralleles `connect()` verhindern.
- [ ] Socketgeneration verwenden, damit alte Events neue Sockets nicht
      beeinflussen.
- [ ] `readyState` unmittelbar vor `send()` pruefen.
- [ ] synchrone Sendefehler behandeln.
- [ ] Pending Requests beim Disconnect sofort definiert ablehnen.
- [ ] Connect-, Request- und Backoff-Timer beim Stoppen bereinigen.
- [ ] absichtlichen Stop ohne Reconnect unterstuetzen.
- [ ] Statuslistener fuer die UI bereitstellen.
- [ ] allgemeines Event-Listener-Modell mit Unsubscribe bereitstellen.

Abnahmekriterien:

- [ ] Pro Dokument existiert hoechstens ein aktiver Verbindungsversuch.
- [ ] Kein Request bleibt nach Disconnect bis zum normalen Timeout offen.
- [ ] Ein absichtlicher Disconnect startet keinen Reconnect.
- [ ] Ein Sendefehler hinterlaesst keinen Pending-Eintrag.

Abhaengigkeiten: K4.

### K6: Stale-Erkennung, Lifecycle, Reconnect und Resync

Ziel: Halb offene Verbindungen und Standby muessen automatisch repariert werden.

Aufgaben:

- [ ] maximale Zeit ohne Servernachricht definieren.
- [ ] stale Socket aktiv schliessen und ersetzen.
- [ ] `online` und `offline` behandeln.
- [ ] `visibilitychange`, `pagehide` und `pageshow` behandeln.
- [ ] BFCache-Wiederherstellung erkennen.
- [ ] nach langer Hintergrundzeit Verbindung und Datenstand validieren.
- [ ] exponentiellen Backoff mit Jitter verwenden.
- [ ] Backoff nach stabiler Verbindung zuruecksetzen.
- [ ] Resync-Hook nach erfolgreichem Reconnect ausloesen.
- [ ] nur idempotente Reads automatisch wiederholen.
- [ ] Scoreboard-Snapshot aus State, Score, Matches und Revision anbieten.
- [ ] UI-Zustaende `verbunden`, `synchronisiert` und `veraltet` trennen.

Abnahmekriterien:

- [ ] Ein unterbrochener Socket wird auch ohne Browser-`close` erkannt.
- [ ] Scoreboard erholt sich nach Standby und WLAN-Wechsel ohne Reload.
- [ ] Reconnects vieler Clients verteilen sich zeitlich.
- [ ] Nach Reconnect ist der sichtbare Snapshot konsistent und aktuell.
- [ ] Writes werden durch Reconnect nicht automatisch doppelt ausgefuehrt.

Abhaengigkeiten: K5 und K3.

### K7: Court-Poller und externe Ressourcen haerten

Ziel: Externe Fehler duerfen Poller und Prozess nicht unkontrolliert blockieren.

Aufgaben:

- [ ] `AbortController` mit festem Court-Fetch-Timeout einsetzen.
- [ ] laufenden Fetch bei Deaktivierung und Shutdown abbrechen.
- [ ] nur eine Pollergeneration gleichzeitig erlauben.
- [ ] Backoff mit Jitter nach externen Fehlern verwenden.
- [ ] JSON-Struktur vor fachlicher Verarbeitung validieren.
- [ ] `lastJson` erst nach erfolgreichem Parse aktualisieren.
- [ ] semantischen Score statt Rohtext vergleichen.
- [ ] letzten Erfolg, Fehler und Datenalter speichern.
- [ ] ScoreLog ueber eine geordnete Queue schreiben.
- [ ] ScoreLog-Appends mit begrenztem Retry behandeln.
- [ ] Queue bei Shutdown drainen oder Rest explizit verwerfen und melden.
- [ ] Google-Sheets-Reads gegebenenfalls mit `batchGet` buendeln.
- [ ] getrennte Least-Privilege-Credentials oder Scopes fachlich pruefen.

Abnahmekriterien:

- [ ] Ein haengender Court-Request blockiert nicht dauerhaft.
- [ ] Deaktivierung beendet auch einen laufenden Request.
- [ ] Es existiert hoechstens eine Polling-Schleife.
- [ ] Ungueltige Court-Daten erzeugen keinen Prozessabbruch.
- [ ] Irrelevante JSON-Aenderungen erzeugen keinen Broadcast.
- [ ] Das Alter der letzten gueltigen Daten ist sichtbar.
- [ ] Ein temporaer fehlgeschlagener ScoreLog-Append wird kontrolliert behandelt.

Abhaengigkeiten: K4; Queue-Shutdown baut auf K11 auf.

### K8: Subscriptions und Push-Modell

Ziel: Nur interessierte Clients erhalten Aenderungen; intensives Polling wird
reduziert.

Aufgaben:

- [ ] `subscribe` und `unsubscribe` definieren.
- [ ] Topics `scores`, `scoreboard-state`, `matches`, `navigator` und
      `monitor:<id>` definieren.
- [ ] Subscriptions pro Client speichern.
- [ ] Score-Pushes nur an `scores`-Abonnenten senden.
- [ ] Court-State bei Aenderung pushen.
- [ ] Tabellenrevisionen nach erfolgreichen Polls vergleichen.
- [ ] Invalidierungs- oder Deltaevents fuer Matches und EntryList senden.
- [ ] Clientseitig nur betroffene Daten neu laden.
- [ ] Subscriptions nach Reconnect automatisch wiederherstellen.
- [ ] Backpressure und `bufferedAmount` kontrollieren.
- [ ] langsame Clients kontrolliert trennen.

Abnahmekriterien:

- [ ] Normale Fachseiten erhalten keine Court-Score-Broadcasts.
- [ ] Scoreboard-State benoetigt kein Ein-Sekunden-Polling mehr.
- [ ] Matchaenderungen werden ohne Seitenreload sichtbar.
- [ ] Nach Reconnect sind alle benoetigten Topics wieder aktiv.
- [ ] Ein langsamer Client laesst Serverpuffer nicht unbegrenzt wachsen.

Abhaengigkeiten: K5, K6 und K2.

### K9: Navigator-/Monitor-Protokoll

Ziel: Navigation und Scrollen werden ereignisbasiert, adressierbar und
korrelierbar.

Aufgaben:

- [ ] stabile Monitor-ID pro Anzeigegeraet definieren.
- [ ] optional stabile Navigator-ID definieren.
- [ ] UUID oder gleichwertige Command-ID pro Zielkommando verwenden.
- [ ] Zielkommando mit Command-ID, Monitor-ID, Ziel und Timestamp senden.
- [ ] Status `received`, `loading`, `loaded` und `failed` unterscheiden.
- [ ] Acknowledgement auf dieselbe Command-ID beziehen.
- [ ] verspaetete Antworten und Load-Events alter Commands ignorieren.
- [ ] iframe-Load mit dem tatsaechlich geladenen Ziel korrelieren.
- [ ] Lade-Timeout und explizites Fehler-Ack einfuehren.
- [ ] erlaubte Ziele und Parameter server- und clientseitig whitelisten.
- [ ] iframe mit passender Sandbox-Policy versehen.
- [ ] Scrollbefehle als Queue oder Sequenz senden.
- [ ] Polling nach dem Push-Umbau entfernen.

Abnahmekriterien:

- [ ] Ein altes Load-Event kann kein neueres Ziel bestaetigen.
- [ ] Mehrere Monitore lassen sich unabhaengig steuern.
- [ ] Schnelle Scrollbefehle gehen nicht verloren.
- [ ] Navigator zeigt Ladefehler statt unbegrenzt zu warten.
- [ ] Im Normalbetrieb gibt es kein 150-ms-Polling mehr.

Abhaengigkeiten: K8 und K1.

### K10: Sichere Darstellung und Fehler-UI

Ziel: Externe Daten werden sicher gerendert und Kommunikationsfehler sind fuer
Benutzer erkennbar.

Aufgaben:

- [ ] Sheet- und State-Werte mit `textContent` oder sicheren DOM-Knoten rendern.
- [ ] unvermeidbares HTML zentral escapen und strikt begrenzen.
- [ ] Content Security Policy definieren.
- [ ] Verbindungsstatus auf Scoreboard und Monitor anzeigen.
- [ ] Zeitpunkt oder Alter der letzten Scoreaenderung ueberwachen.
- [ ] Warnung fuer veraltete Live-Daten anzeigen.
- [ ] Reconnectstatus nicht-blockierend darstellen.
- [ ] dauerhafte Fehler mit Support-ID anzeigen.
- [ ] einheitliches Fehlerobjekt in allen Seiten verwenden.
- [ ] alle Ladeoverlays ueber garantierte Abschlusslogik bereinigen.
- [ ] fehlende Ranglisten-Restrictions als unvollstaendige Daten markieren.

Abnahmekriterien:

- [ ] Manipulierte Sheet-Werte koennen kein HTML oder Script ausfuehren.
- [ ] Ein eingefrorener Score ist als veraltet erkennbar.
- [ ] Fachseiten unterscheiden leere Daten von Kommunikationsfehlern.
- [ ] Fehleranzeigen bleiben sichtbar und sind barrierefrei bedienbar.

Abhaengigkeiten: K2, K4 und K6.

### K11: Readiness, Persistenz und Graceful Shutdown

Ziel: Prozesszustand und Verhalten bei Start, Deploy und Ende sind definiert.

Aufgaben:

- [ ] `/live` fuer reine Prozess-Liveness definieren.
- [ ] `/ready` fuer aktuelle kritische Tabellen und Abhaengigkeiten definieren.
- [ ] maximales Datenalter pro Tabellenkategorie festlegen.
- [ ] bei fehlender Readiness HTTP 503 liefern.
- [ ] Pflichtkonfiguration beim Start validieren.
- [ ] partiell fehlgeschlagenen Initialload korrekt melden.
- [ ] fachlich entscheiden, welcher Court-/Navigator-State persistent sein muss.
- [ ] erforderlichen State in einem geeigneten Store ablegen.
- [ ] `SIGTERM` und `SIGINT` behandeln.
- [ ] neue Requests waehrend Shutdown ablehnen.
- [ ] Poller und Timer stoppen.
- [ ] WebSockets mit definiertem Close-Code schliessen.
- [ ] laufende Writes und ScoreLog-Queue kontrolliert abschliessen.

Abnahmekriterien:

- [ ] Monitoring unterscheidet lebend, bereit und gestoert.
- [ ] Ein normaler Deploy erzeugt nachvollziehbare Close-Gruende.
- [ ] Keine neue Operation startet nach Beginn des Shutdowns.
- [ ] Der vereinbarte State bleibt erhalten oder wird bewusst sichtbar
      zurueckgesetzt.

Abhaengigkeiten: K4 und fachliche Persistenzentscheidung.

### K12: Limits, Tests und Rollout

Ziel: Die Kommunikationsaenderungen werden kontrolliert und reproduzierbar
ausgerollt.

Aufgaben:

- [ ] kleines `maxPayload` fuer WebSocket konfigurieren.
- [ ] HTTP-Bodylimit fuer `/set-active` und kuenftige POST-Routen setzen.
- [ ] Nachrichtenrate und parallele Requests pro Client begrenzen.
- [ ] Login-, Reset- und Write-Raten pro Benutzer und IP begrenzen.
- [ ] `package-lock.json` reproduzierbar versionieren.
- [ ] unterstuetzte Node-Version festschreiben.
- [ ] Unit-Tests fuer Zustandsmaschine, Backoff und Pending Requests erstellen.
- [ ] Integrationstests fuer RPC, Auth und Berechtigungen erstellen.
- [ ] Parallelitaets- und Retry-Tests fuer Writes erstellen.
- [ ] Tests fuer Court-Timeout, ungueltiges JSON und langsame Antworten erstellen.
- [ ] Browsermatrix und verwendete Kiosk-Browser festlegen.
- [ ] Standby, Hintergrundtab, WLAN-Wechsel und Serverneustart testen.
- [ ] Lasttest mit erwarteter und erhoehter Clientzahl ausfuehren.
- [ ] PAJ mindestens einen Veranstaltungstag im Dauerbetrieb pruefen.
- [ ] Rollback fuer Frontend, Backend und Caddy dokumentieren und testen.
- [ ] zuerst PAJ, danach PK und zuletzt Live ausrollen.

Abnahmekriterien:

- [ ] Alle unterstuetzten Browser bestehen Reconnect- und Standby-Tests.
- [ ] Lasttest zeigt keine unkontrolliert wachsenden Pending Requests oder
      Socketpuffer.
- [ ] Sicherheits- und Berechtigungstests decken jeden Endpoint ab.
- [ ] Rollback wurde auf PAJ praktisch verifiziert.
- [ ] Live-Rollout besitzt messbare Erfolgskriterien.

Abhaengigkeiten: Abschluss der jeweils auszurollenden Pakete.

## 27. Empfohlene Reihenfolge

1. K0 aktuelle Funktions- und Integritaetsfehler
2. K1 Personendaten, Authentifizierung und TLS
3. K2 Protokoll- und Endpointvertraege
4. K3 Schreibkonsistenz und Cache-Synchronisation
5. K4 Beobachtbarkeit
6. K5 WebSocket-Zustandsmaschine
7. K6 Stale-Erkennung, Lifecycle, Reconnect und Resync
8. K7 externe Poller und ScoreLog
9. K10 sichere Darstellung und Fehler-UI
10. K8 Subscriptions und Push
11. K9 Navigator-/Monitor-Protokoll
12. K11 Readiness, Persistenz und Shutdown
13. K12 Limits, Tests und Rollout

K1 und die Delete-Korrektur aus K0 sind sofort vorzuziehen, wenn das System aus
nicht vertrauenswuerdigen Netzen erreichbar ist oder reale Personendaten
enthaelt.

## 28. Rolloutgrundsaetze

1. Vor funktionalen Umbauten Messbarkeit und reproduzierbare Tests schaffen.
2. Sicherheitsluecken nicht hinter umfangreichen Push-Umbauten zurueckstellen.
3. Protokollaenderungen versionieren und fuer eine definierte Uebergangsphase
   kontrolliert kompatibel halten.
4. Writes nie automatisch wiederholen, bevor Operation-IDs und Deduplizierung
   existieren.
5. Nur idempotente Reads nach Reconnect automatisch wiederholen.
6. Jede Phase zuerst auf PAJ, danach PK und zuletzt Live pruefen.
7. Fehler-, Reconnect-, Datenalter- und Write-Metriken vor und nach jeder Phase
   vergleichen.
8. Alte Protokollpfade erst nach nachgewiesener stabiler Live-Phase entfernen.

## 29. Gesamtbewertung

Der zentrale Cache und das einfache WebSocket-RPC sind fuer die Groesse der
Anwendung ein nachvollziehbarer Ausgangspunkt. Die Architektur vermeidet, dass
jeder Browser direkt auf Google Sheets zugreift, und trennt Polling, Cache,
Provider und Court-Quelle in kleine Module.

Der aktuelle Sicherheits- und Konsistenzzustand ist jedoch nicht fuer eine
offen erreichbare Anwendung mit realen Personen- und Passwortdaten geeignet.
Insbesondere die ungefilterte Personentabelle, fehlende serverseitige
Autorisierung und das Falschloeschrisiko bei `removeEntryList` haben Vorrang vor
groesseren Komfort- oder Push-Umbauten.

Fuer die beobachtete Zuverlaessigkeit von Scoreboards bleiben eine explizite
Client-Zustandsmaschine, Stale-Watchdog, Backoff mit Jitter, atomarer
Reconnect-Snapshot und sichtbarer Datenalterstatus die wichtigsten Massnahmen.

Fuer Navigator und Monitor ist der groesste Hebel ein adressierbares
Command-Protokoll mit IDs und Push statt globalem 150-ms-Polling. Fuer externe
Ressourcen sind Timeouts, Abort, kontrollierter Backoff und eine geordnete
ScoreLog-Queue erforderlich.

Die alte Analyse fuer v3.0.2 war in ihren Kernaussagen weiterhin zutreffend. Der
aktuelle Stand erfordert vor allem eine neue Priorisierung: zuerst Schutz der
Personendaten und Datenintegritaet, danach Verbindungsrobustheit, Push-Architektur
und betriebliche Reife.
