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
6. Wird bei Analyse oder Umsetzung eine dauerhaft dokumentationsrelevante
   fachliche Information erkennbar, schlage dem User vor einer Aufnahme die
   Zieldatei und den konkret einzutragenden Inhalt vor. Pflege sie erst nach
   Ruecksprache ein; verpflichtendes Branch-Changelog-Bookkeeping bleibt davon
   unberuehrt.
7. Nach jedem erledigten Arbeitsauftrag, der Dateien verändert hat, ist in der
   Zusammenfassung eine vollständige Liste aller geaenderten Dateien auszugeben.
8. Fachliche Commits werden nur auf ausdruecklichen Userauftrag erstellt. Der
   rein vorbereitende Initialcommit eines mit `herrichten` beauftragten neuen
   Seitenbranches ist davon ausgenommen und im Startauftrag bereits freigegeben.
9. Bei laengeren OpenCode-Sessions mit wiederkehrenden Phasen aus Vorbereitung,
   Umsetzung und Abschluss soll vor einer neuen Phase knapp geprueft werden, ob
   ein Modell- oder Reasoning-Wechsel den Kontext- und Kontingentverbrauch senkt,
   ohne das aktuell benoetigte Kontextfenster zu unterschreiten. Leichtgewichtigere
   Modelle sind fuer regelgetriebene Vorbereitungs- und Abschlussroutinen
   bevorzugt, staerkere Modelle fuer Analyse und Umsetzung.
10. Jede neue oder geaenderte Funktion ist im selben Auftrag auf vollstaendige
    Observability zu pruefen. Browserdiagnosen benoetigen einen benannten Eintrag
    in der serverseitigen Event-Allowlist, einen bekannten Seitentyp und Tests;
    Backendoperationen benoetigen strukturierte Abschlusslogs, Fachwrites
    zusaetzlich einen Auditvertrag fuer Start, Erfolg, Ablehnung und unklaren
    Ausgang. Diagnose- und Auditprojektionen duerfen nur kontrollierte Felder und
    keine Passwoerter, Tokens, freien Payloads oder unnoetigen Personendaten
    enthalten. Eine Implementierung ist erst vollstaendig, wenn Logging-, Audit-,
    Datenschutz- und Fehlerpfade gemeinsam geprueft sind.

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
  Passwortspeicherung und Rollen `player`, `player A`, `player B`, `operator`,
  `admin`; Monitorgeraete verwenden eigene Secure-Cookies

## Aktuelle Version

- Einzige Quelle im jeweiligen Checkout: `Backend/package.json`, Feld `"version"`
- Laufzeitabruf je System: `GET /version`
- Aktuelle Soll-Dokumente enthalten keine fest verdrahtete Anwendungsversion;
  historische Versionsangaben stehen im Changelog.

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

Die gemeinsame Observability ist aktuell nur fuer Live und PAJ aktiv. PK bleibt
als Anwendungsvorlage bestehen, wird aber weder gescraped noch in Alloy,
Node Exporter, Grafana-Authentifizierung, Dashboards oder Alerts einbezogen.

## Repository-Struktur

```text
Frontend/    HTML, JavaScript und CSS; von Caddy statisch ausgeliefert
Backend/     Node.js-Server, Services, Vertraege, SQLite und Tests
Project/     Dokumentation und Konfigurationsvorlagen
```

## Doku-Routing

| Thema der Anfrage | Zuerst lesen |
|-------------------|--------------|
| Zweck, Zielgruppen, Nutzungsszenarien oder fachliche Anforderungen | `Project/FACHKONZEPT.txt` |
| Konkrete HTML-Seite | Bei bekanntem Dokumentnamen direkt `Project/software/seiten/<dokumentname>.txt`, sonst Zuordnung in `Project/software/SOFTWARE-DOKU.txt` |
| HTTP/WS, Parameter, Requests oder Responses | `Project/software/ENDPOINTS.txt` |
| WebSocket-Close-Code, Reconnect oder Versionsreload | `Project/software/WEBSOCKET-CLOSE-CODES.txt` |
| Tabellen, Spalten, Formate, IDs oder Beziehungen | `Project/software/DATENBANK.txt` |
| Module, Datenfluss, Cache, Polling, State oder Auth | `Project/software/ARCHITEKTUR.txt` |
| Externe Scoreboard-Einheit, Receiver oder Drehwertinterpretation | `Project/Scoreboard-Funktion.md` |
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
| `personenNormalisieren.html` | Admin-Personendaten normalisieren | keine |

`matches.html` und `preMatches.html` existieren laut aktueller Dokumentation
nicht mehr. `matches` und `preMatches` bestehen nur als WebSocket-Aliase fort.
`court-score-test.html` ist eine technische Testseite und keine fachliche
Anwendungsseite.

## Dokumentation, Versionierung und Git

Die alleinige Detailregel ist `Project/DokuVersGit.txt`; dieser Abschnitt
wiederholt sie bewusst nicht.

Schnellauftrag `herrichten`:

- Auf sauberem `main` autorisiert `herrichten` den vollstaendigen vorbereitenden
  Seitenbranch-Start einschliesslich Branchanlage, nummeriertem Initialstand,
  Initialcommit und anschliessendem `-x`-Arbeitsstand ohne Zwischenfrage.
- Dafuer ist nur der am Anfang von `Project/DokuVersGit.txt` stehende Abschnitt
  `0. SCHNELLABLAUF HERRICHTEN` zu lesen. Weitere Abschnitte werden nur bei einer
  dort genannten Abweichung oder fuer spaetere Arbeitsphasen gelesen.
- `herrichten` autorisiert keinen fachlichen Commit, kein `dokumentieren`, keinen
  Push, Merge, Netzwerkabgleich oder direkte Main-Aenderung.
- Ohne den eindeutigen Auftrag `herrichten` gelten die normalen Freigabe- und
  Rueckfrageregeln aus `Project/DokuVersGit.txt`.
