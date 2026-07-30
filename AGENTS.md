# ePiber - Projektkontext fuer LLM-Sessions

Dieses Dokument ist der Einstiegspunkt fuer neue LLM-Sessions mit OpenCode und
wird aus dem Repository-Root verwendet. Ziel ist ein verlaesslicher Kontext mit
moeglichst wenigen Datei- und Suchzugriffen.

## Arbeitsweise

1. Ordne die konkrete Aufgabe zuerst einer Dokumentationsquelle aus dem Abschnitt
   "Doku-Routing" zu und lies nur die kleinste dafuer notwendige Dokumentationsmenge.
2. Ein eindeutiger Analyse- oder Implementierungsauftrag des Users gilt als
   Freigabe zum gezielten Lesen der dafuer relevanten, nicht sensiblen Dateien in
   `Frontend/` und `Backend/`. Vor Codeaenderungen ist der betroffene Code zu lesen.
3. Vermeide ungezielte projektweite Suchen. Erweitere die Suche nur, wenn die
   bisher gelesenen Quellen nicht ausreichen, und begruende die Erweiterung kurz.
4. Bei Widerspruechen zwischen Dokumentation und aktueller Implementierung gilt
   fuer das Laufzeitverhalten der Code. Benenne die Abweichung, statt sie durch
   Vermutungen aufzuloesen.
5. Lokale Geheimnisdateien wie `Backend/.env` und Service-Account-JSON-Dateien
   duerfen ohne ausdruecklichen Auftrag weder gelesen noch vollstaendig ausgegeben
   werden. Geheimnisfreie `*.example`-Vorlagen duerfen gezielt gelesen werden.

## Projekt

Tennis-Dashboard fuer ASKOE Piberbach. Web-App zur Verwaltung von Ranglisten,
Turnieren, Matches, Live-Scoreboard und Platzsteuerung.

## Tech-Stack

- Frontend: HTML, CSS und Vanilla JavaScript mit ES6-Modulen; kein Framework
- Backend: Node.js 26 mit HTTP, WebSocket v2 und modularen Services
- Persistenz: Google Sheets API fuer Fachdaten, SQLite fuer Anwendungsstate
- Proxy: Caddy fuer HTTPS/WSS, statische Dateien sowie `/ws`, `/api/*`, `/live`,
  `/ready`, `/health`, `/status` und `/version`
- Prozessmanagement: systemd auf Arch Linux
- Authentifizierung: serverseitige Secure-/HttpOnly-Sitzungscookies, scrypt-
  Passwortspeicherung und Rollen `player`, `operator`, `admin`; Monitorgeraete
  verwenden eigene Secure-Cookies

## Aktuelle Version

- Einzige Quelle im jeweiligen Checkout: `Backend/package.json`, Feld `"version"`
- Laufzeitabruf je System: `GET /version`
- Aktueller Main-Stand: `4.1.0`

## Dokumentierter Infrastruktur-Sollstand

`Project/server-configs/` beschreibt den versionierten Soll- und Vorlagenstand,
nicht automatisch den aktuell installierten Zustand oder Laufzeitstatus.

| System / Rolle | App- und API-Basis       | Caddy zu Backend | WebSocket                 |
|----------------|---------------------------|------------------|---------------------------|
| piber / Live   | https://epiber.at         | localhost:8080   | wss://epiber.at/ws        |
| paj / Test     | https://epiber.at:8081    | localhost:8083   | wss://epiber.at:8081/ws   |
| pk / Test      | https://epiber.at:8082    | localhost:8084   | wss://epiber.at:8082/ws   |

TCP-Port 80 wird laut Setup zusaetzlich fuer ACME und HTTP-zu-HTTPS benoetigt.
Server-Roots: `/srv/http/ePiber/{piber,paj,pk}/`

## Repository-Struktur

```text
Frontend/    HTML, JavaScript und CSS; von Caddy statisch ausgeliefert
Backend/     Node.js-Server, Services, Vertraege, SQLite und Tests
Project/     Dokumentation und Konfigurationsvorlagen
```

## Doku-Routing

| Thema der Anfrage | Zuerst lesen |
|-------------------|--------------|
| Konkrete HTML-Seite | Bei bekanntem Dokumentnamen direkt `Project/software/seiten/<dokumentname>.txt`, sonst Zuordnung in `Project/software/SOFTWARE-DOKU.txt` |
| HTTP/WS, Parameter, Requests oder Responses | `Project/software/ENDPOINTS.txt` |
| Tabellen, Spalten, Formate, IDs oder Beziehungen | `Project/software/DATENBANK.txt` |
| Module, Datenfluss, Cache, Polling, State oder Auth | `Project/software/ARCHITEKTUR.txt` |
| Unklare oder projektweite Softwarefrage | `Project/software/SOFTWARE-DOKU.txt` |
| Server, Ports, Caddy oder systemd | `Project/server-configs/SERVER-DOKU.txt`, danach nur die relevante Detaildatei |
| Zeitpunkt oder Grund einer versionierten Aenderung | `Project/ChangeLogs/ChangeLog-main.txt` |
| Dokumentation, Versionierung oder Git | `Project/DokuVersGit.txt`, nur bei entsprechendem Auftrag |

Spezialisierte Detaildokumente haben Vorrang vor Verzeichnisindizes. Ist der
exakte Dokumentname einer Seite bekannt, ist der Softwareindex nicht zu lesen. Bei einer
Querschnittsfrage werden nur die benoetigten Quellen kombiniert, zum Beispiel
Seitendatei plus `ENDPOINTS.txt`.

`Project/2do/` enthaelt nicht-kanonische Analysen und offene Aufgaben. Es wird
nur bei direktem Bezug zur Anfrage gelesen.

`Project/archive/` enthaelt nicht mehr gepflegte historische Dateien. Es wird
nur bei einer ausdruecklich historischen oder Legacy-bezogenen Aufgabe gelesen.

## Lokale Konfiguration und Vorlagen

| Lokale Datei, nicht versionieren | Inhalt | Versionierte Vorlage |
|----------------------------------|--------|-----------------------|
| `Backend/.env` | Sheet-ID, Port, Court-URL und optionale Limits | `Backend/.env.example` |
| Service-Account-JSON-Datei | Google-Service-Account-Schluessel | keine |

WebSocket-URLs werden same-origin abgeleitet; `Frontend/JS/SDK.js` und dessen
Vorlage existieren nicht mehr.

## Schnellreferenz: dokumentierte Anwendungsseiten

| Seite | Funktion | URL-Parameter |
|-------|----------|---------------|
| `index.html` | Dashboard | keine |
| `Bewerbe.html` | Bewerbe-Uebersicht | keine |
| `bewerbsRaster.html` | Turnierraster / KO-Baum | `?id=<bewerbId>` erforderlich |
| `Matches1.html` | Offene und gespielte Matches mit Filtern | keine |
| `players.html` | Spieler-Tabelle | keine |
| `scoreboard.html` | Live-Scoreboard | keine |
| `monitor.html` | Ferngesteuerte Anzeige | keine |
| `navigator.html` | Fernbedienung fuer Monitor | `?profil=<id>`, Standard `1` |
| `entryList.html` | Eintragungsliste | `?id=<bewerbId>` erforderlich |
| `rangliste.html` | Ranglisten-Pyramide | `?id=<bewerbId>`, Standard `2` |
| `RoundRobin.html` | Gruppenphase | `?id=<bewerbId>&paarungslayout=<0-5>`; `id` erforderlich |

`matches.html` und `preMatches.html` existieren laut aktueller Dokumentation
nicht mehr. `matches` und `preMatches` bestehen nur als WebSocket-Aliase fort.
`court-score-test.html` ist eine technische Testseite und keine fachliche
Anwendungsseite.

## Dokumentation, Versionierung und Git

Dokumentations- oder Versionsaenderungen sowie `commit`, `push` und `merge`
werden nur auf ausdruecklichen Userauftrag ausgefuehrt. Ein eindeutiger Auftrag
gilt als Freigabe fuer genau die darin genannten Schritte; nur bei unklarem
Umfang oder zusaetzlichen Schritten ist nachzufragen.

Vor dem ersten solchen Schritt ist `Project/DokuVersGit.txt` zu lesen und der
dort beschriebene Workflow zu befolgen.

### Seitenbranch-Kurzregel

1. Im sauberen Seitenbranch entspricht die sichtbare Paketversion exakt der
   Branch-Commit-ID, zum Beispiel `3.1.12-paj-1-2`. Mit der ersten beabsichtigten
   Aenderung wird sie auf die naechste ID plus `-x` gesetzt, zum Beispiel
   `3.1.12-paj-1-3-x`. Dieser online testbare Wert kennzeichnet uncommittete
   Entwicklung und steht gleichzeitig in package.json, Lockfile und offenem
   Branch-Changelogabschnitt.
2. Ein Seitenbranch darf beliebig viele aufeinanderfolgende Implementierungs-,
   Test- und Korrekturcommits besitzen. Jeder Commit erhaelt die naechste
   lueckenlose Nummer und einen eigenen Abschnitt im temporaeren Branch-Changelog.
3. Neue Anwendungsstaende werden im Seitenbranch ausschliesslich im detaillierten
   `Project/ChangeLogs/ChangeLog-<Branchname>.txt` beschrieben. Permanente
   Software-, Seiten-, Datenbank- und Serverdokumentation bleibt bis zum
   bestaetigten Main-Merge unveraendert.
4. Das temporaere Changelog enthaelt eine dateigenaue Liste aller beim spaeteren
   Main-Versionssprung zu aktualisierenden Dokumente und der jeweils zu
   uebernehmenden Fakten. Es ist bis dahin die alleinige fachliche
   Dokumentationsquelle fuer den Branchstand.
5. `Project/DokuVersGit.txt` und `AGENTS.md` sind organisatorische Ausnahmen und
   duerfen nach ausdruecklicher Userfreigabe bereits im Seitenbranch angepasst
   werden.
6. Erst beim bestaetigten Merge werden Branch-Changelog und Uebernahmeliste in
   `ChangeLog-main.txt` sowie alle betroffenen permanenten Dokumente eingearbeitet.
   Danach wird das temporaere Branch-Changelog im Merge-Commit entfernt.
7. Vor einem Branch-Commit wird `-x` erst nach fachlichem Abschluss entfernt und
   der Changelogabschnitt finalisiert. Scheitert die Finalisierung und folgen
   weitere inhaltliche Aenderungen, ist vorher wieder der `-x`-Stand herzustellen.
   Ein Commit darf niemals `-x` enthalten.
