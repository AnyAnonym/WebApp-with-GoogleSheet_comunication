# ePiber — Projekt-Kontext fuer LLM-Sessions

Dieses Dokument ist der Einstiegspunkt fuer neue LLM-Threads. Ziel: Kontext
aufbauen OHNE die gesamte Codebasis zu durchsuchen. Lies zuerst diese Datei,
dann bei Bedarf die referenzierten Dokumentationsdateien unter Project/.

## Projekt

Tennis-Dashboard fuer ASKOE Piberbach. Web-App zur Verwaltung von Ranglisten,
Turnieren, Matches, Live-Scoreboard und Platzsteuerung.

## Tech-Stack

- Frontend: Vanilla JavaScript (ES6 Modules), HTML, CSS — kein Framework
- Backend: Node.js (WebSocket + HTTP), 6 Module
- Datenbank: Google Sheets API (Spreadsheet als Persistenzlayer)
- Proxy: Caddy (TLS, Static Files, Reverse Proxy /ws)
- Prozessmanagement: systemd auf Arch Linux
- Authentifizierung: SHA-256 Hash, localStorage-Session, kein Server-Token

## Aktuelle Version

Einzige Quelle: `Backend/package.json` → Feld `"version"`
Abruf: `GET /version`

## 3 Systeme auf einem Server

| System | Extern         | Backend-Port | WebSocket              |
|--------|----------------|--------------|------------------------|
| piber  | HTTPS :443     | 8080         | wss://epiber.at/ws     |
| paj    | HTTP :8081     | 8083         | ws://epiber.at:8081/ws |
| pk     | HTTP :8082     | 8084         | ws://epiber.at:8082/ws |

Server-Pfade: `/srv/http/ePiber/{piber,paj,pk}/`

## Repo-Struktur

```
Frontend/    HTML, JS, CSS — Caddy liefert statisch aus
Backend/     Node.js Server (server.js + 6 Module)
Project/     Dokumentation und Konfigurationsvorlagen
```

## Dokumentation — Wo was steht

### Server-Infrastruktur → `Project/server-configs/`
| Datei              | Inhalt                                            |
|--------------------|---------------------------------------------------|
| SERVER-DOKU.txt    | Index des Verzeichnisses                          |
| SERVER-SETUP.txt   | Filestruktur, Ports, Ersteinrichtung, Firewall    |
| CHANGELOG.txt      | Infrastruktur-Aenderungen pro Version             |
| Caddyfile          | Caddy-Konfiguration (Vorlage fuer /etc/caddy/)    |
| systemd/*.service  | 3 systemd-Services (Vorlage fuer /etc/systemd/)   |

### Software → `Project/software/`
| Datei              | Inhalt                                            |
|--------------------|---------------------------------------------------|
| SOFTWARE-DOKU.txt  | Index des Verzeichnisses                          |
| DATENBANK.txt      | Alle 10 Google Spreadsheet Tabellen mit Spalten   |
| ARCHITEKTUR.txt    | Backend-Module, Datenfluss, Shared Frontend, CSS  |
| ENDPOINTS.txt      | Alle 25 WS + 4 HTTP Endpoints im Detail           |
| CHANGELOG.txt      | Software-Aenderungen pro Version                  |
| seiten/*.txt       | Pro HTML-Seite: Funktion, Layout, Bedienung       |

### Weitere Dokumente
| Datei                        | Inhalt                                   |
|------------------------------|------------------------------------------|
| Project/DEPLOYMENT.txt       | Versionierung, Deployment-Workflow       |
| Project/KOMMUNIKATION-ANALYSE.md | Client-Server-Analyse + Arbeitspakete K1-K12 |
| Project/LOGGING-ANALYSE.md   | Logging/Observability + Arbeitspakete L1-L14 |

### Archiv (nicht mehr aktualisiert)
Nichtmehr verwendete "alte Dateien" liegen unter Project/archive
Diese sollen nicht mehr durchsucht werden

## Konfigurations-Dateien (NICHT im Git)

| Datei                          | Inhalt                        | Vorlage               |
|--------------------------------|-------------------------------|-----------------------|
| Backend/.env                   | Sheet-ID, Port, Credentials  | Backend/.env.example  |
| Backend/service-account.json   | Google API Key               | —                     |
| Frontend/JS/SDK.js             | WebSocket-URL pro System     | Frontend/JS/SDK.js.example |

## Wann die Codebasis durchsuchen

**Dokumentation reicht fuer:**
Architektur, Endpoints, DB-Schema, Seitenfunktionen, Server-Setup, Deployment,
Kommunikations- und Logging-Analyse — alles unter `Project/`.

**Codebasis nur noetig fuer:**
Konkreten Bug-Fix, spezifische Implementierungsdetails, CSS-Debugging,
Zeilengenaue Aenderungen und nur im Notfall durchsuchen wenn ein tiefes suchen bzw. ein tiefes Verständnis gewonnen werden soll

**Bei Versionierung:**
1. `git diff` / `git log` lesen
2. Betroffene Doku-Dateien unter Project/ aktualisieren
3. CHANGELOG-Dateien ergaenzen (server-configs/ und/oder software/)

## Schnellreferenz: 13 HTML-Seiten

| Seite             | Funktion                     | URL-Param   |
|-------------------|------------------------------|-------------|
| index.html        | Dashboard                    | —           |
| Bewerbe.html      | Bewerbe-Uebersicht           | —           |
| bewerbsRaster.html| Turnierraster (KO-Baum)      | ?id=        |
| matches.html      | Gespielte Matches            | —           |
| Matches1.html     | Match-Uebersicht mit Filtern | —           |
| players.html      | Spieler-Tabelle              | —           |
| scoreboard.html   | Live-Scoreboard (Vollbild)   | —           |
| monitor.html      | Ferngesteuerte Anzeige       | —           |
| navigator.html    | Fernbedienung fuer Monitor   | ?profil=    |
| entryList.html    | Eintragungsliste             | ?id=        |
| preMatches.html   | Offene Matches               | —           |
| rangliste.html    | Ranglisten-Pyramide          | ?id=        |
| RoundRobin.html   | Gruppenphase                 | ?id= ?paarungslayout= |
