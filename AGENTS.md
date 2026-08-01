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
8. Nach einem vorbereitenden Versionierungsschritt (`-x`-Setzung) wird vor jedem
   Commit explizit beim User nachgefragt, ob der Commit jetzt erfolgen soll.
9. Bei laengeren OpenCode-Sessions mit wiederkehrenden Phasen aus Vorbereitung,
   Umsetzung und Abschluss soll vor einer neuen Phase knapp geprueft werden, ob
   ein Modell- oder Reasoning-Wechsel den Kontext- und Kontingentverbrauch senkt,
   ohne das aktuell benoetigte Kontextfenster zu unterschreiten. Leichtgewichtigere
   Modelle sind fuer regelgetriebene Vorbereitungs- und Abschlussroutinen
   bevorzugt, staerkere Modelle fuer Analyse und Umsetzung.

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
   Branch-Commit-ID, zum Beispiel `<branchname>-2`. Mit der ersten beabsichtigten
   Aenderung wird an diese aktuelle ID `-x` angehaengt, zum Beispiel
   `<branchname>-2-x`. Dieser online testbare Wert kennzeichnet uncommittete
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
7. Integrierte Seitenbranches bleiben lokal und remote dauerhaft als historische
   Staende erhalten. Sie werden weder geloescht noch fuer neue Arbeiten
   wiederverwendet.
8. Erst auf Aufforderung `dokumentieren` wird `-x` nach fachlichem Abschluss
   entfernt und der Changelogabschnitt finalisiert. Folgen danach weitere
   inhaltliche Aenderungen, ist vorher wieder der `-x`-Stand herzustellen. Ein
   Commit darf niemals `-x` enthalten.

### Verpflichtender Arbeits- und Commitablauf

1. Jede neue Aufgabe aus einem vollstaendig committeden Arbeitsbaum beginnt vor
   jeder anderen Aenderung zwingend mit einem neuen `-x`-Entwicklungsstand.
2. In einem bestehenden Seitenbranch wird dafuer an die aktuelle
   Branch-Commit-ID `-x` angehaengt, zum Beispiel von `<branchname>-1` auf
   `<branchname>-1-x`. Der naechste Zielcommit ist `<branchname>-2`.
3. Auf main muss vor jedem `-x`-Stand gefragt werden, ob ein Seitenbranch angelegt
   werden soll. Bei Zustimmung wird zuerst der Seitenbranch angelegt, dessen
   nummerierter Initialstand ohne `-x` vorbereitet und vor dem Initialcommit
   gesondert um Freigabe gefragt. Erst nach dem ausgefuehrten Initialcommit wird
   dessen ID plus `-x` gesetzt.
4. Lehnt der User den Seitenbranch ab, ist eine ausdrueckliche Freigabe als
   direkte Main-Ausnahme erforderlich. Dann wird die naechste Patchversion plus
   `-x` als vorlaeufiger Arbeitsstand verwendet; die endgueltige SemVer-Stufe wird
   erst spaeter bestimmt.
5. Der jeweilige `-x`-Stand muss gleichzeitig in package.json, Lockfile und dem
   offenen Branch-Changelogabschnitt beziehungsweise ChangeLog-main.tmp stehen.
6. Ist diese Vorbereitung nicht ausdruecklich beauftragt, muss vor Arbeitsbeginn
   danach gefragt werden. Ohne Bestaetigung wird nicht implementiert; Arbeit ohne
   `-x` ist nicht zulaessig.
7. Erst auf Aufforderung `dokumentieren` werden Dokumentation und Changelog
   finalisiert. Im Seitenbranch wird die Paketversion von
   `<aktuelle-Commit-ID>-x` auf die naechste Commit-ID gesetzt; bei einer direkten
   Main-Ausnahme wird nach bestaetigter SemVer-Zielversion der vorlaeufige
   Patch-`-x`-Stand durch die endgueltige Version ersetzt.
8. Commit und Push benoetigen jeweils eine eigene ausdrueckliche Aufforderung.
   Sie werden niemals selbststaendig ausgefuehrt.
9. Jeder Commit muss alle auftragsbezogenen neuen, geaenderten, geloeschten und
   umbenannten Dateien einschliesslich Paket-, Lockfile-, Versions-, Doku- und
   Changelog-Dateien enthalten. Unabhaengige Aenderungen bleiben unberuehrt.
10. Vor und nach dem Commit werden Status, staged Diff, unstaged Diff und untracked
   Dateien gegen den Auftragsumfang geprueft. Verbleibende auftragsbezogene
   Dateien machen den Commit unvollstaendig und blockieren Abschlussmeldung und
   Push.
