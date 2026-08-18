# Analyse der Client-Server-Kommunikation

Stand der Analyse: 25.07.2026  
Analysierter Stand: ePiber v3.0.2  
Gegenstand: Frontend, Backend, Caddy, WebSocket, Seitenwechsel, Navigator und Monitor

Archivstatus: Die Analyse ist abgeschlossen und wird nicht fortgeschrieben.

Diese Datei dokumentiert den zum Analysezeitpunkt vorhandenen Zustand. Die
Verbesserungsvorschlaege waren damals nicht umgesetzt; der aktuelle Stand steht
im Schlussabschnitt "Implementierungsstatus 2026-07-29".

## 1. Gesamtarchitektur

```text
Browser
  |-- HTTP: HTML, CSS und JavaScript ueber Caddy
  |-- HTTP: GET /version
  `-- WebSocket: /ws
       |-- Request/Response fuer Anwendungsdaten
       |-- Schreiboperationen
       |-- Navigator- und Scoreboard-State
       |-- Ping/Pong
       `-- Live-Score-Pushes

Caddy
  |-- statische Frontend-Dateien
  `-- Reverse Proxy /ws und HTTP-Endpunkte zum Node.js-Backend

Node.js
  |-- dataProvider.js: WebSocket und fachliche Endpoints
  |-- dataStore.js: gecachte Google-Sheets-Daten
  |-- dataPoller.js: periodisches Google-Sheets-Polling
  |-- stateStore.js: fluechtiger Navigator-/Scoreboard-State
  `-- courtPoller.js: externe Court-Scores und Score-Pushes
```

Caddy ordnet die Systeme wie folgt zu:

| System | Externe Adresse | Backend |
|---|---|---|
| Live | `https://epiber.at` | `localhost:8080` |
| PAJ | `http://epiber.at:8081` | `localhost:8083` |
| PK | `http://epiber.at:8082` | `localhost:8084` |

Referenz: `Project/server-configs/Caddyfile`.

## 2. Beginn der Kommunikation

### 2.1 Laden der statischen Dateien

Caddy liefert HTML, CSS und JavaScript aus. Fuer statische Dateien wird `Cache-Control: no-cache` gesetzt. Der Browser soll Inhalte daher revalidieren, eine bereits geoeffnete Seite laedt neue Dateien jedoch nicht automatisch nach.

`Frontend/JS/global.js` fragt zusaetzlich die Backend-Version relativ zum aktuellen Host ab:

```http
GET /version
```

Diese Anfrage erreicht automatisch das Backend des Hosts, von dem die Seite geladen wurde.

### 2.2 Auswahl des WebSocket-Backends

Die WebSocket-Adresse wird dagegen aus `Frontend/JS/SDK.js` importiert:

```js
export const BACKEND_WS_URL = "ws://epiber.at:8081/ws";
```

Damit wird das Ziel nicht aus dem aktuellen Origin abgeleitet. Eine falsch ausgelieferte oder alte `SDK.js` kann eine Seite mit dem falschen System verbinden. Eine HTTPS-Seite darf ausserdem nicht mit einem unverschluesselten `ws://`-Socket kommunizieren; moderne Browser blockieren dies als Mixed Content.

### 2.3 Automatischer Verbindungsaufbau

Sobald ein Fachmodul `dataClient.js` importiert, ruft das Modul automatisch `connect()` auf. Innerhalb eines HTML-Dokuments wird das ES-Modul nur einmal ausgewertet. Mehrere Fachmodule derselben Seite teilen deshalb einen Socket.

Verschiedene Dokumente besitzen getrennte Verbindungen. Das gilt auch fuer ein aeusseres Monitor-Dokument und die darin geladene iframe-Seite.

Beim Oeffnen gibt es derzeit keinen fachlichen Handshake. Es werden insbesondere nicht uebertragen oder geprueft:

- Protokollversion
- Anwendungsversion
- Seitentyp oder Subscription
- stabile Geraete-ID
- authentifizierte Sitzung
- Rolle oder Endpoint-Berechtigung

## 3. Request/Response-Protokoll

Das WebSocket-Protokoll bildet einen einfachen RPC-Mechanismus ab.

Anfrage:

```json
{
  "type": "request",
  "id": "req-1",
  "endpoint": "matches1",
  "params": {}
}
```

Antwort:

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

Der Ablauf ist:

1. `createEndpoint(name)` erzeugt eine aufrufbare Frontend-Funktion.
2. `request()` wartet maximal zehn Sekunden auf eine offene Verbindung.
3. Der Client vergibt eine fortlaufende Request-ID.
4. Der Request wird in `pendingRequests` vorgemerkt und gesendet.
5. Der Client wartet maximal 15 Sekunden auf die passende Antwort.
6. Das Backend sucht den Handler in `dataProvider.js` und fuehrt ihn aus.
7. Die Response-ID loest das passende Promise im Browser auf.

Die IDs `req-1`, `req-2` usw. sind nur innerhalb eines Dokuments eindeutig. Sie werden nicht in Backend-Logs oder Audit-Eintraege uebernommen.

## 4. Backend-Datenversorgung

Das Backend liest fuer normale Anfragen nicht direkt aus Google Sheets. `dataPoller.js` laedt Tabellen periodisch in `dataStore.js`.

| Daten | Intervall |
|---|---:|
| `Matches1`, Rangliste, EntryList | 10 Sekunden |
| Personen, Bewerbe, Bewerbsart, MatchTyp, Navigator | 30 Sekunden |
| externe Court-Scores | 2 Sekunden, wenn mindestens ein Court aktiv ist |

Ein Client erhaelt daher den letzten gecachten Stand. Eine externe Spreadsheet-Aenderung kann bis zum naechsten Tabellenpoll unsichtbar bleiben.

Nach Schreiboperationen wird der Cache nicht sofort aktualisiert. Unmittelbar folgende Leseanfragen koennen deshalb noch den alten Stand erhalten.

## 5. Kommunikation normaler Fachseiten

Die meisten Fachseiten laden ihre Daten beim Seitenstart einmalig.

| Seite | Typische Daten |
|---|---|
| `players.html` | Personen |
| `Matches1.html` | Matches, Personen, Bewerbe |
| `Bewerbe.html` | Bewerbe, Bewerbsarten |
| `entryList.html` | EntryList, Personen, Bewerbe, Rangliste |
| `rangliste.html` | Rangliste, Personen, Matches, Einschraenkungen |
| `RoundRobin.html` | Matches, Personen, Bewerbe, Bewerbsarten |
| `bewerbsRaster.html` | Matches, Personen, Bewerbe, Bewerbsarten |

Normale Tabellenaktualisierungen werden nicht an offene Seiten gepusht. Der Server aktualisiert zwar seinen Cache, eine bereits geoeffnete Fachseite erhaelt den neuen Stand aber erst durch einen neuen Request oder Reload.

## 6. Scoreboard-Kommunikation

Das Scoreboard kombiniert drei Mechanismen.

### 6.1 Initialisierung

Beim Start werden geladen:

1. Personen
2. Bewerbe
3. Scoreboard-Court-State
4. Matches
5. letzter bekannter Live-Score ueber `courtScores`

### 6.2 Clientseitiges Polling

| Information | Intervall |
|---|---:|
| Platzbelegung, Spieler, Bewerb und Aktivstatus | 1 Sekunde |
| naechste und letzte Matches | 5 Sekunden |

### 6.3 Live-Score-Push

Der eigentliche Spielstand wird nach der Initialisierung als Push verteilt:

```json
{
  "type": "scores",
  "data": {
    "courts": []
  }
}
```

`courtPoller.js` liest die externe Ressource alle zwei Sekunden. Aendert sich der empfangene JSON-Text, wird der neue Stand an alle WebSocket-Clients gesendet. Nur das Scoreboard registriert aktuell einen Score-Listener.

Ein neuer WebSocket-Client erhaelt beim Verbindungsaufbau den letzten bekannten Score. Zusaetzlich fragt das Scoreboard den Endpoint `courtScores` beim Seitenstart einmalig ab.

Danach existiert kein periodischer Score-Fallback. Bleibt eine Verbindung scheinbar offen, transportiert aber keine Push-Nachrichten mehr, bleibt der zuletzt angezeigte Score stehen.

## 7. Keepalive

Der Server sendet alle 30 Sekunden:

```json
{"type":"ping"}
```

Der Client antwortet:

```json
{"type":"pong"}
```

Empfaengt der Server 90 Sekunden lang kein Pong, terminiert er den Client.

Dieser Mechanismus entfernt viele tote Verbindungen, erkennt aber nicht jede halb offene Verbindung sofort. Nach Standby, Netzwechsel oder Energiesparmodus kann ein Browser den Socket noch voruebergehend als offen betrachten.

Die separate Testseite `court-score-test.html` verarbeitet keine Ping-Nachrichten. Im WebSocket-Testmodus wird sie daher nach etwa 90 Sekunden vom Server als tot entfernt.

## 8. Reconnect

Bei einem erkannten `close`-Event:

1. wird `connected` auf `false` gesetzt,
2. wird die Socket-Referenz geloescht,
3. wird nach drei Sekunden neu verbunden.

Aktuelle Einschraenkungen:

- fester Reconnect-Abstand ohne Backoff und Jitter
- kein clientseitiger Timeout fuer die letzte Servernachricht
- keine Behandlung von `online` und `offline`
- keine Behandlung von `visibilitychange`
- keine Behandlung von `pagehide` und `pageshow`
- keine spezielle BFCache-Behandlung
- laufende Requests bleiben bis zum 15-Sekunden-Timeout offen
- keine sichere Wiederholung fehlgeschlagener Schreiboperationen
- kein sichtbarer Verbindungs- oder Stale-Status

Nach einem Serverneustart versuchen alle Clients nahezu gleichzeitig nach drei Sekunden den Reconnect.

## 9. Seitenwechsel und Verbindungsende

Normale Navigation erfolgt ueber Links, `window.location` oder `location.reload()`.

Bei einem Seitenwechsel:

1. beendet der Browser das alte Dokument,
2. wird dessen Socket implizit geschlossen,
3. wird das neue Dokument geladen,
4. importiert es erneut `dataClient.js`,
5. wird ein neuer Socket aufgebaut,
6. werden die Seitendaten erneut geladen.

Ein kontrollierter Disconnect wird nicht ausgefuehrt. Die vorhandene Funktion `disconnect()` ist nicht exportiert und wird nicht verwendet.

Browser koennen Seiten im Back/Forward Cache einfrieren. Da keine `pagehide`-/`pageshow`-Logik existiert, kann der lokale Verbindungszustand nach einer Wiederherstellung zeitweise vom realen Socketzustand abweichen.

## 10. Navigator und Monitor

### 10.1 Zielsteuerung

Der Navigator schreibt einen globalen Zielpfad mit `setNavigatorTarget`. Danach fragt er alle 150 Millisekunden ab, ob der Monitor den Status `loaded` gesetzt hat.

Der Monitor fragt alle zwei Sekunden nach dem aktuellen Ziel. Bei einem neuen Ziel setzt er die iframe-URL und fuegt `monitor=1` sowie einen Cache-Busting-Zeitstempel an.

Nach dem iframe-`load`-Event bestaetigt der Monitor den aktuell vorgemerkten Zielpfad als geladen.

### 10.2 Verbindungsanzahl

`monitor.html` besitzt einen eigenen Socket. Die im iframe geladene Seite besitzt einen zweiten Socket:

```text
monitor.html               -> WebSocket 1
iframe mit scoreboard.html -> WebSocket 2
```

Beim iframe-Seitenwechsel endet der Socket der alten iframe-Seite und die neue Seite baut einen neuen auf. Der Socket der aeusseren Monitorseite bleibt bestehen.

### 10.3 Risiken

- Asynchrone Funktionen werden mit `setInterval` gestartet und koennen ueberlappen.
- Das Scroll-Polling alle 150 Millisekunden kann bei langsamen Requests viele offene Requests erzeugen.
- Aeltere Antworten koennen spaeter als neuere Antworten eintreffen.
- Ein verspaetetes iframe-Load von Ziel A kann den inzwischen vorgemerkten Zustand von Ziel B bestaetigen.
- Navigator-Ziel und Scroll sind global, ohne Navigator-, Monitor- oder Command-ID.
- Scroll ist nur ein ueberschreibbarer Einzelwert; schnelle Befehle koennen verloren gehen.
- Ein iframe-Load gilt auch bei vielen Fehlerseiten als erfolgreich.

## 11. Backend-Neustart

Der Zustand in `stateStore.js` ist rein prozesslokal. Bei einem Neustart gehen verloren:

- Court-Zuordnung
- Court-Aktivstatus
- Navigator-Ziel
- Navigator-Status
- Scroll-State

Der Backendport wird erst nach dem initialen Google-Sheets-Laden geoeffnet. Fehler einzelner Tabellen werden jedoch intern abgefangen, sodass der Start trotz partiell leerer Daten fortgesetzt werden kann.

## 12. Fehler- und Konsistenzrisiken

### 12.1 Verbindungszuverlaessigkeit

- Eine halb offene Verbindung besitzt keinen clientseitigen Stale-Watchdog.
- Kommunikationsfehler werden an vielen Stellen still verschluckt.
- Das Scoreboard zeigt bei Fehlern weiterhin alte Daten.
- Pending Requests werden bei Disconnect nicht sofort abgelehnt.
- `ws.send()` ist nicht gegen ein Schliessen zwischen Statuspruefung und Send abgesichert.
- Langsame Clients werden serverseitig nicht ueber `bufferedAmount` erkannt.

### 12.2 Datenkonsistenz

- Schreiboperationen verwenden teilweise physische Spreadsheet-Zeilennummern.
- Gefilterte Daten koennen zu einer falschen physischen Zeile fuehren.
- Der Cache ist nach Writes bis zum naechsten Poll veraltet.
- Gleichzeitige Add-Operationen koennen dieselbe naechste ID berechnen.
- Deletes verwenden Positionen aus einem moeglicherweise veralteten Cache.

### 12.3 Court-Polling

- Der externe Fetch besitzt keinen Timeout.
- Ein haengender Fetch kann das Score-Polling dauerhaft blockieren.
- Eine Deaktivierung bricht einen bereits laufenden Fetch nicht ab.
- Rohtextvergleich kann bei irrelevanten JSON-Unterschieden Pushes ausloesen.

### 12.4 Sicherheit

- WebSocket-Verbindungen sind nicht authentifiziert.
- Endpoints besitzen keine rollenbasierte Autorisierung.
- `players` liefert die ungefilterte Personentabelle.
- PAJ und PK verwenden HTTP und `ws://`.
- Es gibt keine Origin-Pruefung und keine serverseitige Pfadpruefung fuer WebSocket-Upgrades.
- Rate Limits und kleine Payload-Limits fehlen.
- Sheet-Daten werden teilweise ungeescaped ueber `innerHTML` ausgegeben.

## 13. Verbesserungsvorschlaege

### Prioritaet 1: Verbindung robust machen

- WebSocket-Client als Zustandsmaschine modellieren: `connecting`, `connected`, `stale`, `reconnecting`, `offline`, `stopped`.
- Zeitpunkt der letzten Servernachricht und des letzten Pings speichern.
- Eine Verbindung aktiv neu aufbauen, wenn fuer einen definierten Zeitraum keine Servernachricht eintrifft.
- Nach jedem Reconnect einen vollstaendigen aktuellen Snapshot laden.
- Pending Requests beim Disconnect sofort definiert ablehnen.
- Nur idempotente Leseoperationen automatisch wiederholen.
- Reconnect mit exponentiellem Backoff und Zufallsanteil ausfuehren.
- Browserereignisse `online`, `offline`, `visibilitychange`, `pagehide` und `pageshow` behandeln.
- Auf dem Scoreboard Verbindungsstatus und Alter des letzten Scores anzeigen.
- Stille Catch-Bloecke durch kontrollierte Fehlerbehandlung ersetzen.

### Prioritaet 2: Polling durch Events ersetzen

- Scoreboard-State bei Aenderungen pushen, statt jede Sekunde zu pollen.
- Match-Aenderungen als Invalidierungs- oder Datenereignis pushen.
- Navigator-Ziele direkt an registrierte Monitore senden.
- Scrollbefehle als einzelne Commands senden.
- Topic-Subscriptions einfuehren, damit Score-Pushes nur Scoreboards erreichen.
- Einen atomaren initialen Scoreboard-Snapshot fuer State, Scores und Matchdaten anbieten.

### Prioritaet 3: Navigator-Protokoll absichern

- Eindeutige Command-ID fuer jedes Ziel verwenden.
- Monitor-ID und optional Navigator-ID mitfuehren.
- Acknowledgement auf dieselbe Command-ID beziehen.
- Aeltere Antworten und Load-Events ignorieren.
- Scrollbefehle als Queue oder Sequenz statt als Einzelwert behandeln.
- iframe-Ziele auf erlaubte lokale Seiten beschraenken.
- Lade-Timeout und explizite Fehlerbestaetigung einfuehren.

### Prioritaet 4: Datenkonsistenz verbessern

- Schreiboperationen anhand stabiler Datensatz-IDs statt Zeilenpositionen ausfuehren.
- Die aktuelle Zeile unmittelbar vor dem Write serverseitig aufloesen.
- Optimistic Locking oder Versionspruefungen verwenden.
- Nach erfolgreichen Writes den Cache direkt aktualisieren oder gezielt neu laden.
- Add- und Delete-Operationen serialisieren.
- Schreiboperationen mit Operation-ID idempotent machen.

### Prioritaet 5: Backend stabilisieren

- Court-Fetch mit Timeout und `AbortController` versehen.
- Laufenden Fetch bei Deaktivierung abbrechen.
- WebSocket-Backpressure ueber `bufferedAmount` ueberwachen.
- Liveness und Readiness trennen.
- Den Server nur als bereit melden, wenn kritische Tabellen aktuell sind.
- Navigator- und Court-State persistent speichern, falls Neustarts ohne Zustandsverlust erforderlich sind.

### Prioritaet 6: Sicherheit

- Alle Systeme ueber HTTPS und WSS betreiben.
- WebSocket-Ziel aus dem aktuellen Origin ableiten oder deployment-sicher konfigurieren.
- Authentifizierte Sitzungen oder kurzlebige Tokens verwenden.
- Rollen und Berechtigungen pro Endpoint pruefen.
- Personendaten auf benoetigte Felder reduzieren.
- WebSocket-Origin und Pfad pruefen.
- Verbindungs-, Nachrichten- und Payload-Limits setzen.
- Sheet-Werte sicher als Text rendern.

### Prioritaet 7: Beobachtbarkeit

- Global eindeutige Request-ID verwenden.
- Client-ID, Seitentyp, Verbindungsbeginn und letzten Pong erfassen.
- Close-Code und Close-Grund protokollieren.
- Requestdauer, Fehler, Timeouts und Reconnects messen.
- Alter der letzten Court- und Spreadsheet-Daten ausgeben.
- Verbindungsausfaelle und veraltete Daten sichtbar alarmieren.

## 14. Gesamtbewertung

Die Architektur ist fuer wenige Clients grundsaetzlich funktionsfaehig und reduziert Google-Sheets-Zugriffe durch den zentralen Cache. Die groessten Risiken liegen in der Annahme, dass Browser und Netzwerke WebSocket-Abbrueche immer sauber melden, im intensiven Polling von Navigator und Scoreboard sowie in fehlender Authentifizierung und Datenminimierung.

Fuer das beobachtete Einfrieren einzelner Scoreboards sind ein Stale-Connection-Watchdog, ein vollstaendiger Reconnect-Snapshot, sichtbarer Verbindungsstatus und kontrollierte Fehlerlogs die wirkungsvollsten ersten Verbesserungen.

## 15. Detaillierter Umsetzungs-Backlog

Die folgenden Arbeitspakete sind in einer sinnvollen technischen Reihenfolge angeordnet. Vor jedem produktiven Rollout sollte die Umsetzung zuerst auf PAJ, danach auf PK und zuletzt auf Live geprueft werden.

### Arbeitspaket K1: Ausgangszustand messbar machen

Ziel: Vor funktionalen Umbauten muss sichtbar sein, wann und warum Verbindungen ausfallen.

Aufgaben:

- [ ] Fuer jede Browserverbindung eine zufaellige, nur fuer die Laufzeit gueltige Client-ID erzeugen.
- [ ] Den Seitentyp wie `scoreboard`, `monitor`, `navigator` oder `matches` beim Verbindungsaufbau melden.
- [ ] Zeitpunkt der letzten empfangenen Servernachricht im Client speichern.
- [ ] Zeitpunkt des letzten Ping und Pong speichern.
- [ ] Anzahl der Reconnect-Versuche im Client zaehlen.
- [ ] WebSocket-Close-Code und Close-Grund erfassen.
- [ ] Im Backend pro Client Verbindungsbeginn, Seitentyp, letzten Request und letzten Pong bereitstellen.
- [ ] `/status` um Datenalter und Verbindungszustand erweitern, ohne sensible Payloads auszugeben.
- [ ] Einen sichtbaren Diagnosemodus fuer PAJ vorsehen, der Verbindungsstatus und letzte Nachricht zeigt.

Abnahmekriterien:

- [ ] Ein eingefrorener Scoreboard-Client ist in `/status` eindeutig von einem gesunden Client unterscheidbar.
- [ ] Ein Verbindungsabbruch enthaelt Client-ID, Seitentyp, Close-Code und Zeitpunkt.
- [ ] Es werden keine Passwort-Hashes, Personendaten oder vollstaendigen Payloads protokolliert.

Abhaengigkeiten: keine.

### Arbeitspaket K2: WebSocket-Client als Zustandsmaschine

Ziel: Der Verbindungszustand soll explizit und reproduzierbar sein.

Aufgaben:

- [ ] Zustaende `idle`, `connecting`, `connected`, `stale`, `backoff`, `offline` und `stopped` definieren.
- [ ] Erlaubte Zustandsuebergaenge dokumentieren und zentral implementieren.
- [ ] Mehrfaches paralleles `connect()` verhindern.
- [ ] Einen manuellen Stop-Zustand vorsehen, der keinen automatischen Reconnect ausloest.
- [ ] `ws.send()` nur bei real offenem Socket ausfuehren und synchrone Sendefehler behandeln.
- [ ] Pending Requests bei Disconnect sofort mit einem definierten Fehler beenden.
- [ ] Timer fuer Connect-Warten, Request-Timeout und Reconnect beim Stoppen bereinigen.
- [ ] Statusaenderungen ueber Listener bereitstellen, damit Seiten ihre UI aktualisieren koennen.
- [ ] Mehrere Score-Listener beziehungsweise ein allgemeines Event-Listener-Modell ermoeglichen.
- [ ] Unsubscribe-Funktionen fuer Listener bereitstellen.

Abnahmekriterien:

- [ ] Es existiert zu jedem Zeitpunkt hoechstens ein aktiver Verbindungsversuch pro Dokument.
- [ ] Kein Request bleibt nach einem Disconnect bis zum normalen Timeout haengen.
- [ ] Ein absichtlicher Disconnect startet keinen Reconnect.
- [ ] Ein Sendefehler erzeugt einen definierten Fehler und keinen verwaisten Pending-Eintrag.

Abhaengigkeiten: K1.

### Arbeitspaket K3: Stale-Watchdog und Browser-Lifecycle

Ziel: Halb offene oder nach Standby unbrauchbare Verbindungen automatisch erkennen.

Aufgaben:

- [ ] Einen Grenzwert fuer die maximal erlaubte Zeit ohne Servernachricht definieren.
- [ ] Bei Ueberschreitung den Socket aktiv schliessen und einen Reconnect ausloesen.
- [ ] `window.online` und `window.offline` behandeln.
- [ ] Bei `offline` neue Requests sofort mit einem klaren Offline-Fehler ablehnen.
- [ ] Bei `online` einen kontrollierten Reconnect starten.
- [ ] `visibilitychange` behandeln und nach langer Hintergrundzeit den Zustand validieren.
- [ ] `pagehide` verwenden, um normale Navigation und BFCache-Frieren zu unterscheiden.
- [ ] `pageshow` verwenden, um BFCache-Wiederherstellung zu erkennen.
- [ ] Nach BFCache-Wiederherstellung Socket und Datenstand aktiv validieren.
- [ ] Browser- und Geraetetests fuer Standby, WLAN-Wechsel und Energiesparmodus definieren.

Abnahmekriterien:

- [ ] Ein unterbrochener Socket wird auch ohne zeitnahes Browser-`close` erkannt.
- [ ] Nach Standby aktualisiert sich ein Scoreboard ohne manuellen Reload wieder.
- [ ] Nach WLAN-Ausfall und Wiederkehr wird die Verbindung automatisch wiederhergestellt.
- [ ] Zuruecknavigation aus dem BFCache fuehrt nicht zu einem dauerhaft falschen `connected`-Status.

Abhaengigkeiten: K2.

### Arbeitspaket K4: Reconnect, Backoff und Resynchronisierung

Ziel: Reconnects sollen Server und Clients nicht ueberlasten und immer einen konsistenten Datenstand herstellen.

Aufgaben:

- [ ] Exponentiellen Backoff definieren, beispielsweise 1, 2, 4, 8, 15 und maximal 30 Sekunden.
- [ ] Zufallsanteil hinzufuegen, damit viele Hosts nicht gleichzeitig reconnecten.
- [ ] Backoff nach einer stabilen Verbindung wieder zuruecksetzen.
- [ ] Nach erfolgreichem Reconnect einen Resync-Hook ausloesen.
- [ ] Fuer Scoreboard einen atomaren Snapshot aus Court-State, aktuellem Score und benoetigten Matchdaten definieren.
- [ ] Nach Reconnect den Snapshot laden, bevor die Seite wieder als aktuell gilt.
- [ ] Bei Snapshot-Fehlern den Zustand als `stale` anzeigen.
- [ ] Nur Leseoperationen automatisch erneut senden.
- [ ] Fuer Schreiboperationen Operation-IDs und serverseitige Deduplizierung vorbereiten.
- [ ] Reconnect- und Resync-Tests bei Backend-Neustart automatisieren.

Abnahmekriterien:

- [ ] Nach einem Backend-Neustart verteilen sich Reconnects zeitlich.
- [ ] Ein Scoreboard zeigt nach Reconnect garantiert den aktuellen und nicht nur den letzten lokal bekannten Score.
- [ ] Eine Schreiboperation wird durch Reconnect nicht doppelt ausgefuehrt.
- [ ] Die UI unterscheidet `verbunden`, `synchronisiert` und `veraltet`.

Abhaengigkeiten: K2 und K3.

### Arbeitspaket K5: Sichtbarer Verbindungs- und Datenstatus

Ziel: Benutzer sollen erkennen, ob angezeigte Daten aktuell sind.

Aufgaben:

- [ ] Auf Scoreboard und Monitor einen dezenten Verbindungsindikator vorsehen.
- [ ] Zeitpunkt der letzten empfangenen Scoreaenderung anzeigen oder intern ueberwachen.
- [ ] Bei ueberschrittenem Datenalter eine Warnung `Live-Daten veraltet` anzeigen.
- [ ] Reconnect-Status ohne Blockierung der vorhandenen Anzeige darstellen.
- [ ] Bei dauerhaftem Fehler eine manuelle Neuverbinden-Aktion anbieten.
- [ ] Technische Details hinter einem Diagnosebereich verbergen.
- [ ] Fehlermeldungen mit kurzer Support-ID versehen.
- [ ] Barrierefreie Statusmeldungen und ausreichenden Farbkontrast pruefen.

Abnahmekriterien:

- [ ] Ein eingefrorener Score ist fuer Benutzer als veraltet erkennbar.
- [ ] Kurzzeitige Reconnects verdecken das Scoreboard nicht dauerhaft.
- [ ] Support kann anhand einer Fehler-ID den passenden Servervorgang finden.

Abhaengigkeiten: K1 bis K4.

### Arbeitspaket K6: Subscriptions und Push-Modell

Ziel: Nur interessierte Clients sollen relevante Aenderungen erhalten; intensives Polling soll entfallen.

Aufgaben:

- [ ] Nachrichtentypen `subscribe` und `unsubscribe` definieren.
- [ ] Topics wie `scores`, `scoreboard-state`, `matches`, `navigator` und `monitor:<id>` definieren.
- [ ] Subscriptions pro WebSocket-Client im Backend speichern.
- [ ] Score-Pushes nur an `scores`-Abonnenten senden.
- [ ] Court-State bei jeder Aenderung an `scoreboard-state`-Abonnenten pushen.
- [ ] Nach erfolgreichem Sheets-Poll Tabellenrevisionen vergleichen.
- [ ] Bei geaenderten Matches ein Invalidierungsereignis oder Delta senden.
- [ ] Clientseitig nach einer Invalidierung gezielt nur die betroffenen Daten laden.
- [ ] Subscription-Zustand nach Reconnect automatisch wiederherstellen.
- [ ] Unbenutzte Subscriptions beim Seitenende entfernen.

Abnahmekriterien:

- [ ] Normale Fachseiten erhalten keine Court-Score-Broadcasts mehr.
- [ ] Scoreboard-State muss nicht mehr jede Sekunde gepollt werden.
- [ ] Matchaenderungen werden ohne kompletten Seitenreload sichtbar.
- [ ] Nach Reconnect sind alle erforderlichen Subscriptions wieder aktiv.

Abhaengigkeiten: K2 und K4.

### Arbeitspaket K7: Navigator-/Monitor-Protokoll

Ziel: Navigation und Scrollen sollen ereignisbasiert, korrelierbar und frei von Races funktionieren.

Aufgaben:

- [ ] Stabile Monitor-ID pro Anzeigegeraet definieren.
- [ ] Optional stabile Navigator-ID pro Steuergeraet definieren.
- [ ] Fuer jedes Zielkommando eine UUID als Command-ID erzeugen.
- [ ] Zielkommando mit Command-ID, Monitor-ID, Ziel und Timestamp senden.
- [ ] Monitor-Acknowledgement auf dieselbe Command-ID beziehen.
- [ ] Status `received`, `loading`, `loaded` und `failed` unterscheiden.
- [ ] Verspaetete Acknowledgements alter Commands ignorieren.
- [ ] iframe-Load mit dem tatsaechlich geladenen Ziel korrelieren.
- [ ] Lade-Timeout und explizites `failed`-Acknowledgement implementieren.
- [ ] Erlaubte iframe-Ziele server- und clientseitig whitelisten.
- [ ] Scrollbefehle als Commands mit Sequenznummer senden.
- [ ] Scrollbefehle nicht durch einen globalen Einzelwert ueberschreiben.
- [ ] 150-ms-Status- und Scroll-Polling nach erfolgreichem Push-Umbau entfernen.

Abnahmekriterien:

- [ ] Ein verspaetetes Load-Event kann kein neueres Ziel bestaetigen.
- [ ] Mehrere Monitore lassen sich unabhaengig steuern.
- [ ] Schnelle Scrollklicks gehen nicht verloren.
- [ ] Navigator zeigt Ladefehler statt dauerhaft zu blinken.
- [ ] Im Normalbetrieb gibt es kein 150-ms-Polling mehr.

Abhaengigkeiten: K6.

### Arbeitspaket K8: Datenkonsistenz bei Schreiboperationen

Ziel: Kommunikation darf keine falschen oder doppelten Spreadsheet-Aenderungen erzeugen.

Aufgaben:

- [ ] Alle Write-Endpoints inventarisieren und ihre Request-Schemas dokumentieren.
- [ ] Frontend- und Backend-Parameternamen fuer jeden Endpoint abgleichen.
- [ ] Physische Zeilennummern aus Clientrequests entfernen.
- [ ] Stabile Match-, Entry- und Personen-IDs als Ziel verwenden.
- [ ] Aktuelle Tabellenzeile unmittelbar vor dem Write serverseitig aufloesen.
- [ ] Versionsnummer oder `updatedAt` fuer Optimistic Locking definieren.
- [ ] Konflikte mit einem eigenen Fehlercode an den Client melden.
- [ ] Erfolgreiche Writes sofort im Cache nachvollziehen oder gezielt neu pollen.
- [ ] Add-Operationen serialisieren, damit IDs nicht doppelt vergeben werden.
- [ ] Delete-Operationen anhand stabiler ID und nicht anhand gecachter Position ausfuehren.
- [ ] Operation-ID fuer idempotente Wiederholung einfuehren.
- [ ] Parallelitaets- und Retry-Tests erstellen.

Abnahmekriterien:

- [ ] Eine ignorierte Zeile vor einem Match kann keinen Write auf das falsche Match verursachen.
- [ ] Zwei gleichzeitige Adds erzeugen unterschiedliche IDs.
- [ ] Wiederholung derselben Operation-ID erzeugt keine doppelte Aenderung.
- [ ] Direkt nach erfolgreichem Write liefert ein Read den neuen Stand.

Abhaengigkeiten: K1; Operation-IDs bauen auf K4 auf.

### Arbeitspaket K9: Court-Poller und Broadcast

Ziel: Externe Scorekommunikation soll bei Netzproblemen kontrolliert weiterlaufen.

Aufgaben:

- [ ] `AbortController` mit festem Fetch-Timeout einsetzen.
- [ ] Laufenden Fetch bei Poller-Deaktivierung abbrechen.
- [ ] Retry-Backoff fuer die externe Scorequelle definieren.
- [ ] Letzten erfolgreichen Fetch und Datenalter speichern.
- [ ] Semantischen Score vergleichen statt den gesamten Rohtext.
- [ ] Nur fachlich relevante Aenderungen broadcasten.
- [ ] Broadcast-Empfaenger ueber Subscriptions begrenzen.
- [ ] `bufferedAmount` langsamer Clients ueberwachen.
- [ ] Langsame oder dauerhaft blockierte Clients kontrolliert trennen.
- [ ] Einen aktuellen Score-Snapshot unabhaengig vom letzten Push bereitstellen.
- [ ] Tests fuer Timeout, ungueltiges JSON und langsame Antwort erstellen.

Abnahmekriterien:

- [ ] Ein haengender externer Request blockiert den Poller nicht dauerhaft.
- [ ] Deaktivierung beendet auch einen laufenden Fetch.
- [ ] Irrelevante JSON-Aenderungen erzeugen keinen Score-Push.
- [ ] Das Alter der letzten gueltigen Court-Daten ist sichtbar.

Abhaengigkeiten: K1 und K6.

### Arbeitspaket K10: Authentifizierung und Transportabsicherung

Ziel: Lese- und Schreibkommunikation soll nur fuer berechtigte Clients moeglich sein.

Aufgaben:

- [ ] Rollenmodell fuer oeffentliche Anzeige, Spieler, Navigator und Administration definieren.
- [ ] Serverseitige Sitzung oder kurzlebiges signiertes Token einfuehren.
- [ ] WebSocket-Handshake authentifizieren.
- [ ] Berechtigungen pro Endpoint serverseitig pruefen.
- [ ] `players` in oeffentliche und geschuetzte Datenprojektionen aufteilen.
- [ ] Passwort-Hash und Reset-Felder niemals an allgemeine Clients senden.
- [ ] Alle Systeme auf HTTPS und WSS umstellen.
- [ ] WebSocket-Origin gegen eine Allowlist pruefen.
- [ ] WebSocket-Pfad serverseitig auf `/ws` begrenzen.
- [ ] `maxPayload` und Nachrichtenrate begrenzen.
- [ ] Schreiboperationen pro Benutzer und IP rate-limitieren.
- [ ] Sicherheits- und Berechtigungstests pro Endpoint erstellen.

Abnahmekriterien:

- [ ] Ein anonymer Client kann keine Schreiboperation ausfuehren.
- [ ] Ein Anzeigeclient erhaelt keine Passwort-, E-Mail- oder Resetdaten.
- [ ] Fremde Origins werden abgewiesen.
- [ ] PAJ, PK und Live verwenden ausschliesslich verschluesselte Kommunikation.

Abhaengigkeiten: Rollen- und Sessionkonzept; sollte vor einem breiten Push-Rollout abgeschlossen werden.

### Arbeitspaket K11: Readiness, Persistenz und Shutdown

Ziel: Prozesszustand und Verbindungsverhalten bei Start und Ende sollen definiert sein.

Aufgaben:

- [ ] `/live` fuer reine Prozess-Liveness definieren.
- [ ] `/ready` fuer aktuelle kritische Tabellen und funktionsfaehige Abhaengigkeiten definieren.
- [ ] Maximales Datenalter pro Tabellenkategorie festlegen.
- [ ] Bei fehlender Readiness HTTP 503 liefern.
- [ ] Startup bei ungueltiger Pflichtkonfiguration abbrechen.
- [ ] Partiell fehlgeschlagene Initialloads korrekt behandeln.
- [ ] Persistenzbedarf fuer Court- und Navigator-State fachlich entscheiden.
- [ ] Falls erforderlich State in einem persistenten Store ablegen.
- [ ] `SIGTERM` und `SIGINT` behandeln.
- [ ] Neue Requests beim Shutdown ablehnen.
- [ ] Poller stoppen und WebSockets mit Close-Code schliessen.
- [ ] Laufende Writes kontrolliert abschliessen.

Abnahmekriterien:

- [ ] Monitoring kann lebenden, bereiten und gestoerten Prozess unterscheiden.
- [ ] Ein normaler Deploy erzeugt nachvollziehbare WebSocket-Close-Grunde.
- [ ] Der vereinbarte Navigator-/Court-State bleibt bei Neustart erhalten oder wird bewusst sichtbar zurueckgesetzt.

Abhaengigkeiten: K1 und fachliche Persistenzentscheidung.

### Arbeitspaket K12: Test- und Rolloutplan

Ziel: Die Kommunikationsaenderungen sollen ohne Ausfall schrittweise eingefuehrt werden.

Aufgaben:

- [ ] Protokollversion in Client und Server aufnehmen.
- [ ] Fuer eine Uebergangsphase alte und neue Nachrichtenversion kontrolliert unterstuetzen.
- [ ] Unit-Tests fuer Zustandsmaschine, Backoff und Pending Requests erstellen.
- [ ] Integrationstests fuer Request/Response und Berechtigungen erstellen.
- [ ] Browsermatrix fuer Chrome, Firefox, Edge, Safari und verwendete Kiosk-Browser festlegen.
- [ ] Tests fuer Standby, Hintergrundtab, WLAN-Wechsel und Serverneustart ausfuehren.
- [ ] Lasttest mit erwarteter und erhoehter Clientzahl durchfuehren.
- [ ] PAJ mindestens einen vollstaendigen Veranstaltungstag im Dauerbetrieb testen.
- [ ] Fehler- und Reconnect-Metriken vor und nach der Aenderung vergleichen.
- [ ] Rollback-Verfahren fuer Frontend, Caddy und Backend dokumentieren.
- [ ] Zuerst PAJ, danach PK und zuletzt Live ausrollen.
- [ ] Alte Protokollpfade erst nach stabiler Live-Phase entfernen.

Abnahmekriterien:

- [ ] Alle definierten Browser bestehen den Reconnect- und Standby-Test.
- [ ] Der Lasttest zeigt keine unkontrolliert wachsenden Pending Requests oder Socket-Puffer.
- [ ] Rollback wurde auf PAJ praktisch getestet.
- [ ] Live-Rollout besitzt messbare Erfolgskriterien und einen verantwortlichen Beobachtungszeitraum.

Abhaengigkeiten: Abschluss der jeweils auszurollenden Arbeitspakete.

## 16. Empfohlene Reihenfolge

1. K1 Messbarkeit
2. K2 Zustandsmaschine
3. K3 Stale-Watchdog und Lifecycle
4. K4 Reconnect und Resync
5. K5 sichtbarer Status
6. K8 Datenkonsistenz
7. K10 Authentifizierung und TLS
8. K6 Subscriptions und Push
9. K7 Navigator-/Monitor-Protokoll
10. K9 Court-Poller
11. K11 Readiness, Persistenz und Shutdown
12. K12 Tests und Rollout

Die Sicherheitsaufgaben aus K10 sollten unabhaengig von der Reihenfolge sofort vorgezogen werden, wenn das System aus nicht vertrauenswuerdigen Netzen erreichbar ist.

## 17. Implementierungsstatus 2026-07-29

Die Abschnitte 1 bis 16 bleiben als historische Analyse des damaligen Stands und
als Begruendung des Umbaus erhalten. Fuer Version 4.0.0 wurden die
Kommunikationsarbeitspakete K1 bis K11 sowie die automatisierbaren Teile von K12
im Branch `3.1.12-paj-1` umgesetzt und getestet. Dazu gehoeren insbesondere
Vertraege und Datenprojektionen, Cookie-/Rollenauthentifizierung, persistenter
Anwendungsstate, WebSocket-v2, Clientzustandsmaschine und Browser-Lifecycle,
Subscriptions und Resync, adressierte Monitorsteuerung, stabile Sheets-Writes,
Court-Poller-Haertung, Liveness/Readiness und Graceful Shutdown.

Die sofortige Offline-Ablehnung ist ebenfalls umgesetzt. Das gilt sowohl fuer
Requests, die bei bereits erkanntem Offline-Zustand neu gestartet werden, als
auch fuer Requests, die beim `offline`-Ereignis bereits auf eine Verbindung
warten; beide erhalten unmittelbar den Fehlercode `OFFLINE` statt erst nach dem
Verbindungs- oder Request-Timeout.

Der finale Scoreboard-Stand wertet Verbindung, Synchronisation und Datenalter
intern aus und verwendet Lade-/Fehleroverlays, zeigt aber keine separaten
Verbindungs-, Synchronisations- oder Court-Quellen-Badges. `Logging` und
`ScoreLog` gehoeren ebenfalls nicht zu einem EventID-/Queue-Redesign; beide
behalten ihre dreispaltigen Legacy-Vertraege.

Automatisch beziehungsweise statisch wurden auf dem Branch unter anderem zwei
Buildlaeufe mit jeweils 68 Tests, fokussierte Regressionstests, `npm audit
--omit=dev`, Caddy-Validierung und systemd-Verifikation dokumentiert. Daraus folgt
keine Aussage ueber noch nicht ausgefuehrte Abschlusspruefungen des offenen
Main-Merges.

Offen sind die manuellen K12-Anteile: Google-Sheets-Backup und Migration,
Browser-/Kiosk- und Rollenmatrix, responsive Scoreboard-Abnahme, Standby,
BFCache, WLAN-Wechsel und Reconnect, Mehrmonitorbetrieb, Serverrestart/SIGTERM,
Google-Sheets-Fehlerfaelle, erwartete und doppelte Spitzenlast, ein kompletter
Veranstaltungstag im Dauerbetrieb sowie der praktische Rollback. Verbindliche
Reihenfolge, Voraussetzungen und Abnahmekriterien stehen in der
[Rollout-Checkliste](../server-configs/ROLLOUT-CHECKLIST.md).
