# ePiber Rollout-Checkliste

Stand: 16.08.2026

Diese Checkliste ist das verbindliche Gate fuer die aktuelle Reihenfolge **PAJ -> Live**. PK bleibt deaktiviert und wird erst in einem eigenen spaeteren Release aufgenommen. Jede aktive Stufe verwendet exakt denselben bestaetigten Release-Commit und dieselben versionierten Caddy-/systemd-Vorlagen. Abweichungen, offene Pflichtpunkte oder ein Branchsuffix in der Version stoppen die Promotion.

## Freigabeprotokoll

- [ ] Release-Commit: `____________________________`
- [ ] Freigegebene Version: `<FREIGEGEBENE_VERSION>`
- [ ] Verantwortliche Person: `____________________________`
- [ ] Zweite pruefende Person: `____________________________`
- [ ] Wartungsfenster und Kommunikationsweg festgelegt.
- [ ] Vorheriger freigegebener Commit/Release fuer Rollback notiert: `____________________________`
- [ ] `Backend/package.json` und `Backend/package-lock.json` melden exakt `<FREIGEGEBENE_VERSION>` und gehoeren zum eingetragenen Release-Commit.
- [ ] `git status` des Deploymentstands ist sauber; keine lokalen Code-/Vorlagenaenderungen werden ausgerollt.
- [ ] Nach abgeschlossener Nachbeobachtung wird ein datensparsames Protokoll unter `Project/server-configs/rollouts/<FREIGEGEBENE_VERSION>.md` angelegt; Inhalt und Ausschluesse entsprechen `rollouts/README.md`.

## 1. Google-Sheets-Backup und Schema

- [ ] Unmittelbar vor der Migration eine vollstaendige Kopie des jeweiligen Spreadsheets erstellt, nicht nur einzelne Tabs.
- [ ] Backup-ID, Zeitpunkt und verantwortliche Person dokumentiert; Backup ist lesbar und gegen versehentliche Bearbeitung geschuetzt.
- [ ] Service-Account hat Bearbeiterzugriff auf genau das richtige systemspezifische Spreadsheet.
- [ ] Alle von `Backend/tableSchemas.js` verlangten Tabs und Pflichtspalten vorhanden.
- [ ] `Personen` besitzt die Poller-Pflichtspalten `ID`, `Vorname`, `Nachname`, `E-Mail`, `PasswdHash`, `Aktiv`, `Role`.
- [ ] Die fuer die Erstvergabe benoetigte Zusatzspalte `KennwortVergessen` ist vorhanden und fuer den Service-Account beschreibbar.
- [ ] `Bewerb`: `ID`, `Bezeichnung`, `BewerbsartID`; `Bewerbsart`: `ID`, `Bezeichnung`.
- [ ] `Matches1`: `ID`, `Matchdate`, `Forderungdate`, `BewerbID`, `BewerbRunde`, `Spieler1ID`, `Spieler3ID`, `Ergebnis`.
- [ ] `RL-Platzierung`: `BewerbID`, `PersonID`, `Rang`; `Navigator`: `Name`, `Ziel`.
- [ ] Jede relevante Personenzeile besitzt explizit `player`, `operator` oder `admin` in `Role`; Gross-/Kleinschreibung wurde vereinheitlicht.
- [ ] Mindestens eine aktive, praktisch getestete Adminperson vorhanden.
- [ ] Fuer den Erstvergabe-Test steht bei genau der vorgesehenen aktiven Person `x` in `KennwortVergessen`; andere Werte gelten nicht als Freigabe.
- [ ] Keine leeren oder ungueltigen Rollen als Migrationsrest akzeptiert. Die technische Normalisierung zu `player` mit einmaliger Warnung ist nur ein Sicherheitsfallback.
- [ ] `EntryList` verwendet die Spalten `ID`, `BewerbID`, `PersonenID`, `Entrydate`; neue Werte haben das Format `YYMMDD-HHMM` (Wiener Zeit).
- [ ] Google-Sheets-Tabs `Logging` und `ScoreLog` werden vom Backend nicht mehr gelesen oder beschrieben. Ihre bisherigen Inhalte sind vor einer optionalen Entfernung separat gesichert archiviert; ein automatischer Import in SQLite findet nicht statt.
- [ ] `scorelog.sqlite` und `audit.sqlite` sind als getrennte Fachhistorien angelegt und nicht mit `state.sqlite` zusammengelegt.
- [ ] ScoreLog-Event-IDs, Court-Folgenummern sowie Audit-Request-/Operation-IDs sind eindeutig und nach Neustart fortsetzbar.
- [ ] Eindeutige, nichtleere IDs und eindeutige Personen-E-Mail-Adressen stichprobenartig beziehungsweise automatisiert geprueft.
- [ ] Schreibrechte auf `Personen`, `Matches1` und `EntryList` praktisch mit dem vorgesehenen Service-Account bestaetigt; fuer `Logging` und `ScoreLog` sind keine Sheet-Schreibrechte mehr erforderlich.

## 2. Developer Metadata

- [ ] Google Sheets API erlaubt Developer-Metadata-Suche und `batchUpdate` fuer den Service-Account.
- [ ] `epiberRecord` wird als dokumentweite, zeilengebundene Developer Metadata fuer stabile Datensaetze in `Personen`, `Matches1` und `EntryList` verwendet; es ist keine Sheet-Spalte.
- [ ] Bestehende `epiberRecord`-Eintraege sind je Wert `players:<ID>`, `matches1:<ID>` beziehungsweise `entryList:<ID>` hoechstens einer fachlichen Zeile eindeutig zugeordnet.
- [ ] Keine Metadata zeigt auf eine andere ID, eine leere Zeile oder den falschen Tab. Abwesenheit vor dem ersten stabilen Update/Delete ist zulaessig.
- [ ] Admin-`/status` zeigt vor dem Testwrite `pendingMetadataIntents: 0`.
- [ ] Je ein kontrolliertes stabiles Update/Delete auf PAJ erzeugt beziehungsweise verwendet Metadata fuer genau die beabsichtigte Zeile; benachbarte Zeilen bleiben unveraendert.

## 3. Credentials und lokale Konfiguration

- [ ] Private Service-Account-Schluessel vor dem Deployment nach der geltenden Rotationpolicy erneuert beziehungsweise bestaetigt.
- [ ] Credential-Quelldatei ist nicht in Git und enthaelt einen gueltigen privaten Schluessel.
- [ ] Live-Datei: `/srv/http/ePiber/piber/Backend/epiberpiber-31aebe556ced.json`.
- [ ] PAJ-Datei: `/srv/http/ePiber/paj/Backend/epiberpaj-5032a34639bf.json`.
- [ ] PK-Datei: `/srv/http/ePiber/pk/Backend/service-account.json`.
- [ ] Jede Credential-Quelldatei gehoert `root:root` und hat Modus `0600`.
- [ ] systemd bindet sie ausschliesslich als Credentialname `google-service-account` ein; der Prozess nutzt `%d/google-service-account`.
- [ ] Kein privater Schluesselinhalt oder Laufzeit-Credentialwert steht in `.env`,
  Journal oder Browserantworten. Root-kontrollierte Quellpfade duerfen ohne
  Schluesselinhalt in Betriebsdokumentation und systemd-Vorlagen stehen.
- [ ] `.env` gehoert `root:<service-user>`, hat hoechstens Modus `0640` und enthaelt die richtige `SHEET_ID`, `PORT` und HTTPS-`COURT_URL`.
- [ ] Live-Sheet-ID: `1E1CYezDcScIBvH9ebjN0hOkvttTdA6PFIgYKDMaeE04`.
- [ ] PAJ-Sheet-ID: `1auOvEer7i1PW7LO4QX73188Q81Q6QguGyt0zadIIaqo`.
- [ ] PK-Sheet-ID vor PK-Promotion verbindlich eingetragen und gegengeprueft.

## 4. Installation und statische Verifikation

- [ ] `node --version` meldet Node.js 26.x.
- [ ] `npm --version` meldet npm 12.0.2.
- [ ] `package-lock.json` ist versioniert, unveraendert und Lockfile-Version 3.
- [ ] Im `Backend/` des Releasecheckouts ist `npm ci --omit=dev` erfolgreich.
- [ ] `npm run build` ist erfolgreich; statischer Check und vollstaendige Testsuite sind gruen.
- [ ] `npm audit --omit=dev` meldet keine nicht akzeptierte Produktionsluecke.
- [ ] `caddy validate --config /etc/caddy/Caddyfile` ist mit der Vorlage aus dem eingetragenen Release-Commit erfolgreich.
- [ ] Die aktiven Units `epiber-piber.service`, `epiber-paj.service` und `epiber-grafana-auth.service` bestehen `systemd-analyze verify`; die installierte PK-Unit bleibt unveraendert.
- [ ] Caddy proxyt nur `/ws`, `/api/*`, `/live`, `/ready`, `/health`, `/version`, `/status` auf die aktiven Backends; `/metrics` und `/api/admin/grafana-auth` bleiben auf allen Origins extern gesperrt. Nur die zentrale Live-Origin proxyt das separat geschuetzte `/grafana/*` ueber den Grafana-Unix-Socket. Auf PK bleibt ausser der expliziten 404-Sperre des internen Authpfads das bestehende Anwendungsrouting unveraendert.
- [ ] Caddy-Roots zeigen exakt auf die jeweiligen `Frontend/`-Verzeichnisse; Backend, `.env`, Credentials und SQLite sind nicht statisch erreichbar.
- [ ] CSP und Security-Header sind vorhanden; alle drei Origins und WebSockets verwenden HTTPS/WSS ohne Mixed Content.
- [ ] Es existiert keine systemspezifische `SDK.js`; der Browser verbindet same-origin auf `/ws`.
- [ ] Beobachtete WebSocket-Schliesscodes und Reconnectentscheidungen stimmen mit `Project/software/WEBSOCKET-CLOSE-CODES.txt` ueberein.

## 5. systemd, SQLite und Prozessgrenzen

- [ ] User, WorkingDirectory, `.env`, Credentialquelle und `INSTANCE_ID` stimmen je System.
- [ ] `LISTEN_HOST=127.0.0.1`; Node lauscht Live auf 8080, PAJ auf 8083 und PK auf 8084 nur an Loopback.
- [ ] `PUBLIC_ORIGIN` ist Live `https://epiber.at`, PAJ `https://epiber.at:8081`, PK `https://epiber.at:8082`.
- [ ] `STATE_FILE` ist `/var/lib/epiber-<system>/state.sqlite`.
- [ ] `SCORELOG_FILE` ist `/var/lib/epiber-<system>/scorelog.sqlite`; `AUDITLOG_FILE` ist `/var/lib/epiber-<system>/audit.sqlite`.
- [ ] `StateDirectory=epiber-<system>`, Verzeichnismodus 0700, SQLite-Modus 0600 und `UMask=0077` bestaetigt.
- [ ] Alle drei SQLite-Dateien verwenden Foreign Keys, WAL und `synchronous=FULL`; Dateisystem hat fuer die unbegrenzte Fachhistorie ausreichend freien Platz.
- [ ] Konsistente Backups aller drei SQLite-Dateien erstellt. Bei gestopptem Dienst wurden jeweilige DB, WAL und SHM gemeinsam behandelt; alternativ wurden SQLite-Onlinebackups verwendet.
- [ ] journald-Drop-in ist installiert: persistente Speicherung, maximal 1 GiB und 14 Tage; die Werte passen zur Hostkapazitaet.
- [ ] Jede ePiber-Unit besitzt eindeutigen `SyslogIdentifier`, explizite Journal-Ausgabe und Rate-Limit 1000/30s.
- [ ] Sandbox und leere Capability-Sets entsprechen der Vorlage; es wurden keine pauschalen Schreib- oder Home-Ausnahmen hinzugefuegt.
- [ ] `KillSignal=SIGTERM`, `SHUTDOWN_GRACE_MS=90000` und `TimeoutStopSec=95` stimmen zusammen.
- [ ] Installation und Dienststeuerung erfolgen nur durch root oder autorisierte Betreiber; die `nologin`-Service-User `piber`, `paj` und `pk` koennen weder Deployments noch Caddy-/systemd-Dienste steuern und fuehren nur den Node-Prozess aus.
- [ ] Der Dienst wurde mit parallel laufendem `journalctl -u <unit> -f --since now` neu gestartet; Start, Initialisierung und Testfehler wurden zeitlich zugeordnet, und exportierte Auszuege wurden vor Ablage auf Geheimnisse und personenbezogene Daten geprueft.

## 6. Health, Status und Transport

- [ ] `/version` liefert HTTP 200 und exakt Version `<FREIGEGEBENE_VERSION>` aus dem eingetragenen Release-Commit.
- [ ] `/live` liefert HTTP 200 mit `status: ok`.
- [ ] `/ready` und `/health` liefern nach Initialisierung HTTP 200 mit `status: ready`.
- [ ] Anonymes `/status` wird mit 401 abgewiesen.
- [ ] Admin-`/status` zeigt plausible Tabellenalter, Poller, Courtquelle, Provider, Monitor-, State-, ScoreLog-, Auditlog- und Sheets-Zustaende.
- [ ] Admin-`/status` enthaelt keine Cookies, Tokens, Passwortwerte, privaten Schluessel oder `.env`-Secrets.
- [ ] `/status` bleibt `no-store`; Zugriff und Auswertung sind auf Admins und autorisierte Betreiber fuer den Betriebszweck begrenzt. IP-Adressen, Benutzer-IDs/-namen sowie Client-/Geraetekennungen werden als geschuetzte personenbezogene Diagnosedaten weder oeffentlich angezeigt noch ungefiltert in Journale, Tickets, Screenshots oder Freigabeprotokolle uebernommen.
- [ ] `pendingMetadataIntents` ist 0; ScoreLog und Auditlog sind `open` und `ready`, ihre Zaehler/Folgenummern sind plausibel.
- [ ] Browser-DevTools zeigen HTTPS, WSS-101-Upgrade auf same-origin `/ws`, Hello/Welcome-Protokoll v2 und keine CSP-, Zertifikats-, Origin- oder Mixed-Content-Fehler.
- [ ] Externe Firewall erlaubt 80, 443, 8081 und 8082; Backendports 8080, 8083 und 8084 sind extern nicht erreichbar.
- [ ] Das Zertifikat wird an Live, PAJ und PK fuer den Hostnamen `epiber.at` ohne Warnung validiert; die Portnummer ist kein Zertifikatsname.
- [ ] Negative Klartextprobe fuer `http://epiber.at:8081` und `http://epiber.at:8082`: Weder Anwendung noch API-Daten werden ueber Plain HTTP ausgeliefert. Ablehnung, Verbindungsabbruch oder TLS-Fehler sind zulaessig; ein Redirect auf HTTPS wird auf diesen Ports nicht vorausgesetzt.

## 7. Gemeinsame Observability nach der Live-Promotion

Dieser Abschnitt wird erst ausgefuehrt, nachdem derselbe Anwendungstand zuerst
auf PAJ und danach Live erfolgreich abgenommen wurde. PK bleibt in diesem
Release deaktiviert und ist ein eigener spaeterer Rollout. Der Abschnitt blockiert die
vorherigen Anwendungsstufen nicht; danach blockiert jeder offene Punkt die
Gesamtfreigabe.

- [ ] Live und PAJ liefern denselben freigegebenen Stand und intern jeweils `GET /metrics` im Prometheus-Textformat 0.0.4; PK wird nicht abgefragt.
- [ ] Externe Aufrufe von `/metrics` an allen drei Origins liefern keine Metriken; Loki, Prometheus, Alloy, Node Exporter und Auth-Broker lauschen nur auf Loopback, Grafana ausschliesslich auf dem gruppengeschuetzten Unix-Socket.
- [ ] Prometheus zeigt exakt `live` und `paj` im Job `epiber` dauerhaft `up`; es existiert kein aktives PK-Ziel.
- [ ] Node Exporter erfasst `epiber-piber.service`, `epiber-paj.service`, `epiber-grafana-auth.service` und `grafana.service` genau einmal auf dem gemeinsamen Host, nicht aber PK.
- [ ] Alloy liest die Live-/PAJ-Backendjournale, das Auth-Brokerjournal und `/var/log/caddy/epiber-{live,paj}-access.json`; Loki zeigt Ereignisse mit korrektem `deployment`.
- [ ] Caddy-Access-Logs gehoeren `caddy:grafana-alloy`, haben Modus 0640, das Verzeichnis Modus 2750, rotieren maximal 14 Tage und enthalten keine Querystrings, Header, Cookies, Tokens oder Quelladressen. Alloy ist kein Mitglied der Caddy-Gruppe; nach einer kontrolliert erzwungenen Rotation kann Alloy die neue Datei lesen.
- [ ] Grafana lauscht nur auf `/run/epiber-observability/grafana.sock` mit `grafana:caddy` und Modus 0660. Caddy stellt nur Grafanas `/metrics` mit explizitem Loopback-Bind auf `127.0.0.1:3001` bereit; `ss` zeigt keinen Wildcard-Listener, andere Pfade und externe Zugriffe werden abgewiesen.
- [ ] Personen-, Session-, IP-, Request-/Support-, Client- und Geraetewerte sind keine Prometheus- oder Loki-Labels; personenbezogene JSON-Felder werden nur fuer den Betriebszweck verwendet.
- [ ] Loki loescht normale Frontenddiagnose nach 14 und gezielte Diagnose nach 7 Tagen; Prometheus-Retention und 5-GiB-Grenze passen zur gemessenen Serienzahl beider aktiver Backends.
- [ ] `https://epiber.at/grafana/` funktioniert als einzige Grafana-Origin; PAJ leitet `/grafana/` samt Unterpfad permanent dorthin weiter, PK besitzt keine Grafana-Integration.
- [ ] Je eine aktuelle aktive Adminsession aus Live und PAJ erhaelt ohne zweite Passwortabfrage Zugriff. Eine PK-only-Session erhaelt keinen Zugriff. Benutzernamen sind korrekt als `epiber-<Instanz>:<Personen-ID>` getrennt.
- [ ] Jeder zugelassene ePiber-Admin besitzt Grafana-Organisationsrolle `Admin`, aber keine Serveradminrolle, und kann Metriken und Logs von Live und PAJ abfragen.
- [ ] Anonyme, Player-, Operator-, stale, abgelaufene, widerrufene, deaktivierte und nach Rollenentzug nicht mehr administrative Sessions erhalten keinen Grafana-Zugriff.
- [ ] Vom Client gesetzte `X-WEBAUTH-USER`-/`X-WEBAUTH-ROLE`-Header werden nicht vertraut. Der Broker reicht pro Backend nur dessen eigenes Cookie weiter.
- [ ] Bei mehreren gueltigen Admincookies verwendet der Broker deterministisch Live vor PAJ; PK-Cookies werden ignoriert und ein ausgefallenes aktives Realm blockiert eine andere gueltige Adminsession nicht.
- [ ] Logout, Sessionablauf, Rollenentzug und Deaktivierung sperren den naechsten HTTP-Request und WebSocket-Neuaufbau. Eine bestehende Grafana-Live-Verbindung ist keine Autoritaet fuer privilegierte Entscheidungen.
- [ ] Grafana-Assets, API und Live-WebSocket funktionieren ohne CSP-, Redirect-, Mixed-Content-, Cookie- oder Subpathfehler.
- [ ] Fuenf gemeinsame Dashboards sind vorhanden; die Deploymentauswahl `live|paj` trennt Anwendungswerte eindeutig, Hostressourcen werden nicht doppelt gezaehlt.
- [ ] Das Normalisierungs-Auditpanel zeigt Adminname/-ID, Ziel-Personen-ID und resultierenden Zielnamen. Nur Aktiv und Rolle enthalten kontrollierte Alt-/Neuwerte; andere Personenfelder erscheinen ohne Wert als geaendert. Bestehende Loki-Zeilen bleiben unveraendert.
- [ ] Anwendungsalerts erzeugen getrennte Alarm- und Recoveryzustaende je Deployment; Host-/Stackalarme existieren nur einmal.
- [ ] SMTP, Benachrichtigungsversuche, oeffentliche Dashboards, lokale und externe Snapshots, Pluginverwaltung, automatische Pluginvorinstallation und automatische Pluginupdates sind deaktiviert.
- [ ] `/var/lib/grafana/plugins` gehoert `grafana:grafana` und hat Modus 0750; ein wiederholter Installerlauf erhaelt beziehungsweise repariert diesen Zustand.
- [ ] Ein vor dem Installerlauf vorhandenes Caddy-Access-Log wird wiederholbar auf `caddy:grafana-alloy` und Modus 0640 repariert.
- [ ] Die Grafana-Datenbankbereitschaft wird sowohl mit kompaktem als auch mit formatiertem Health-JSON erkannt.
- [ ] Grafana-SQLite wurde konsistent gesichert; das lokale Break-glass-Passwort wurde nicht fuer den Normalzugang verwendet oder in Browser, Journal und Protokoll ausgegeben.
- [ ] Ausfall von Grafana, Prometheus oder Loki beeintraechtigt ePiber nicht; Auth-Broker-, Loki- und Pipeline-Recovery sowie ein Observability-Rollback wurden kontrolliert geprueft.

## 8. Rollen und Fachfunktionen auf PAJ

- [ ] Anonymous sieht nur oeffentliche Daten/Profile und kann keine geschuetzten Writes ausfuehren.
- [ ] `player` kann sich anmelden/abmelden, eigenes Profil und Mitgliederprofil sehen, eigenes Passwort aendern, Forderung und EntryList fachregelkonform bedienen.
- [ ] `operator` kann zusaetzlich Navigator und Courtsteuerung bedienen, aber keine Admin-Monitorverwaltung oder fremde Passwortsetzung.
- [ ] `admin` kann Resetnachweis erzeugen, Passwort direkt setzen sowie Monitore provisionieren, rotieren und widerrufen.
- [ ] Nur `admin` sieht `adminLogging.html`, kann globale Frontend-Level/Sampling/Batch/Flushwerte und temporaere Zielpersonen setzen oder entfernen und sieht die festen Retentionwerte 14/7 Tage; alle drei Mutationstypen erscheinen im Auditlog.
- [ ] Eine temporaere Zielperson erscheint mit ID, Klarname, Rolle, Level, Ersteller, Ablauf und plausibler Restzeit. Die Policy greift im Collector sofort, erreicht offene Standardseiten spaetestens beim Sessionrefresh, zeigt der Person einen neutralen Ablaufhinweis und faellt nach Ablauf auf die globale Policy zurueck.
- [ ] Nur `admin` kann ueber `POST /api/admin/password-setup` die Erstvergabe freigeben oder aufheben; Profilanzeige und Sheetwert `KennwortVergessen` wechseln dabei konsistent zwischen `x` und leer.
- [ ] `POST /api/password-setup` akzeptiert nur E-Mail plus neues Passwort einer aktiven, mit `KennwortVergessen = x` freigegebenen Person; unbekannte, inaktive, nicht freigegebene und nachtraeglich deaktivierte Personen werden ohne Passwortwrite abgewiesen.
- [ ] Erfolgreiche Erstvergabe verbraucht die Freigabe atomar: `KennwortVergessen` ist danach leer und ein zweiter Setupversuch wird abgewiesen.
- [ ] Aktivstatus und Freigabe werden auch bei einem konkurrierenden Aenderungsversuch unmittelbar vor dem Setup-Write erneut geprueft.
- [ ] Erstvergabe widerruft alle bestehenden Sitzungen der Zielperson vor und nach dem Write; offene Tabs wechseln in den abgemeldeten Zustand und das alte Passwort funktioniert nicht mehr.
- [ ] Falsche Rolle, abgelaufene/ungueltige Session und widerrufenes Monitorgeraet werden serverseitig abgewiesen.
- [ ] Passwortaenderung/-reset widerruft die vorgesehenen Sitzungen; Cross-Tab Login/Logout bleibt konsistent.
- [ ] Personenprofile zeigen anonym nur ID/Name und angemeldet die vorgesehenen Kontakt-/Geburtsdaten; Adminaktionen sind nur fuer Admin sichtbar und wirksam.
- [ ] Login, eigene Passwortaenderung und Erstvergabe funktionieren mit mindestens einem freigegebenen Browser-Passwortmanager; `username`, `current-password`, `new-password` und `one-time-code` werden passend erkannt, ohne Passwortwerte in URL, Logs oder Storage zu schreiben.
- [ ] Erfolgreicher und fehlgeschlagener Login erzeugen je einen Auditdatensatz mit Quell-IP und normalisierter gueltiger Login-E-Mail; nur der erfolgreiche Datensatz enthaelt serverseitige Benutzer-ID, Namenssnapshot und Rolle. Ein syntaktisch ungueltiger E-Mail-Rohtext wird nicht gespeichert.
- [ ] Der Journalspiegel zeigt fuer Login-Audits den Namen, aber nur maskierte E-Mail und IP; vollstaendige Werte sind ausschliesslich in der geschuetzten `audit.sqlite` vorhanden und werden weder ueber `/status` noch in oeffentliche Tickets oder Screenshots uebernommen.
- [ ] Direkte externe Requests koennen `X-Forwarded-For` nicht zur Auditfaelschung verwenden. Forwarded-Header werden nur von `127.0.0.1`/`::1` akzeptiert; lokale Prozesse gehoeren zur Host-Vertrauensgrenze und duerfen den Loopback-Backendport nicht unkontrolliert verwenden.
- [ ] Frontend-Events akzeptieren nur erlaubte Ereignisse und technische Felder; ID, Klarname, Rolle und IP stammen nachweislich serverseitig aus Session/Verbindung. Inaktive Personen werden nicht weiter als authentifizierte Diagnoseidentitaet behandelt, anonyme Events nur nach expliziter Freigabe.
- [ ] journald zeigt `frontend_client_event` mit korrekter Support-ID, Diagnoseprofil und Retentionklasse, aber ohne Payloads, DOM-/Profildaten, freie Fehlermeldungen, Stacks, E-Mail, Telefon, Cookies, Tokens oder Passwortwerte. Personenbezogene Felder werden nur autorisierten Betreibern zugaenglich gemacht.
- [ ] Wiederverwendete oder aktionsfremde Audit-Event-IDs werden mit `AUDIT_LOG_EVENT_CONFLICT` abgewiesen und koennen terminale Zeilen nicht zurueckstufen.
- [ ] Login-, Passwortaenderungs-, Reset-, Erstvergabe- und Admin-Passwortmodale schliessen nicht durch Backdropklick oder Escape, sondern nur explizit ueber Abbrechen/Schliessen; waehrend eines Requests sind Schliessen und Doppel-Submit gesperrt, danach werden Formulare und sichtbare Passwoerter zurueckgesetzt.
- [ ] Matches/Forderungen, EntryList Add/Remove und Ranglistenrestriktionen wurden mit realistischen Daten geprueft; jede Mutation erzeugt den vorgesehenen SQLite-Auditeintrag.
- [ ] Unklare fachliche Writes werden als `unknown` behandelt und nicht automatisch erneut ausgefuehrt.

## 9. Browser, Kiosk, Monitor und Scoreboards auf PAJ

- [ ] Aktuelle freigegebene Browser auf Desktop und Mobilgeraeten getestet.
- [ ] Mobile Navigation oeffnet ueber den Hamburger, zeigt je Sessionzustand korrekt Anmelden oder Profil/Abmelden sowie `Spieler` nur angemeldet und schliesst bei Navigation beziehungsweise Authaktion ohne verdecktes Folgemodal.
- [ ] Mobile Navigation wurde mit Touch, Tastatur, schmalem Hochformat und kleinem Querformat getestet; Links, Schliessen, Fokus und Scrollen bleiben erreichbar und es entstehen keine doppelten Authaktionen.
- [ ] `players.html` zeigt anonym die Anmeldeaufforderung und angemeldet die erlaubte Spielerliste; Authwechsel, Invalidierung, Leerzustand und Fehlerzustand rendern ohne alte oder fremde Profildaten.
- [ ] `bewerbsRaster.html?id=...` rendert Einzel und Doppel, BYE, die exakt kleingeschriebenen Marker `[wo]` und `[ret]`, `[gesetzt]`, Ergebnisse und Gewinner korrekt; Varianten wie `[w.o.]`, `[WO]` und `[RET]` werden nicht als Abschlussmarker akzeptiert; fehlende/ungueltige Bewerb-ID, leere Daten, Reload, Authwechsel und Topic-Invalidierung wurden geprueft.
- [ ] Raster-/Gruppenumschaltung bei RoundRobin-Bewerben funktioniert wiederholt ohne doppelte Inhalte oder Handler; breite Raster bleiben horizontal bedienbar und die eingebettete Gruppenansicht entspricht der Einzelansicht.
- [ ] `RoundRobin.html?id=...&paarungslayout=0-5` rendert Einzel/Doppel, Gruppenrang, Aufstiegsmarkierung, offene und gespielte Paarungen sowie Datum/Uhrzeit je Layout korrekt; manipulierte Namen/Ergebnisse werden nicht als HTML ausgefuehrt.
- [ ] Kiosk-Hardware mit der echten Bildschirmaufloesung, Vollbildmodus und Autostart getestet.
- [ ] Scoreboard ueber 1300 px mit Einzel- und Doppelpaarungen abgenommen.
- [ ] Scoreboard von 1001 bis 1300 px mit Einzel- und Doppelpaarungen abgenommen.
- [ ] Scoreboard bis 1000 px mit Einzel- und Doppelpaarungen abgenommen.
- [ ] Mobile Hoch- und Querformate, einschliesslich kleiner Querformate, mit Einzel- und Doppelpaarungen abgenommen.
- [ ] Namen, gemeinsame Heim-/Gast-Feldhoehen, Scores, Satzwerte, Datum/Bewerb, Seitenpanel, Topausrichtung und `100dvh` sind ohne Abschneiden oder Ueberlagerung korrekt.
- [ ] Scoreboard-Snapshot, Score-/Tabellen-Subscriptions, Revisionen und Resync liefern nach Reload und Reconnect konsistente Daten.
- [ ] Tabelle `Matchtyp` besitzt mindestens `ID`, `Satztiebreak` und `Entscheidender Satz`; `Matches1.MatchtypID` ueberschreibt den Bewerbsstandard.
- [ ] Neue Matchtyp-Zuweisungen persistieren `displayRules: { schemaVersion: 1, source: "matchtyp", matchtypId, satztiebreak, entscheidenderSatz }`; Individualzuweisungen persistieren `matchtypId: ""` und `displayRules: null`.
- [ ] Sehr alte persistierte Match-Courts ohne `matchtypId` wurden separat erkannt und kontrolliert neu zugewiesen; sie werden weder automatisch migriert noch als unresolved Matchtyp-ID diagnostiziert.
- [ ] Ein kontrollierter Legacy-Court mit `matchtypId`, aber ohne `displayRules`, wird nach dem ersten verwendbaren Matchtyp-Load ohne Score-Reset, ScoreLog-Write oder Court-Event migriert. Admin-`/status` zeigt `state.displayRulesMigration.attempted: true`, den Court in `migratedCourts` und kein `unresolved` fuer diesen Court.
- [ ] Der idempotente Migrationsfolgeaufruf beim Initialstart behaelt den erfolgreich migrierten Court in `state.displayRulesMigration.migratedCourts`; ohne neue Migration entstehen dadurch keine weiteren Scoreboard-State-/Score-Events.
- [ ] Nicht aufloesbare Legacy-Courts bleiben unveraendert. Admin-`/status` listet je Eintrag unter `state.displayRulesMigration.unresolved` exakt `court`, `matchtypId` und einen Grund `MATCHTYP_NOT_FOUND`, `MATCHTYP_SCHEMA_INVALID` oder `MATCHTYP_RULES_INVALID`.
- [ ] Nur ein aktiver unresolved Court blockiert Readiness: `/ready` und `/health` liefern 503, waehrend Admin-`/status` `status.court.displayRulesReady: false` und den Court unter `status.court.unresolvedActiveRules` zeigt. Derselbe unresolved Court blockiert im deaktivierten Zustand nicht und bleibt zur Diagnose unter `state.displayRulesMigration.unresolved` sichtbar.
- [ ] Recovery der Matchtyp-Tabelle migriert den Legacy-Court beim erneuten Load und entfernt diesen Readiness-Blocker. Alternativ entfernt eine erfolgreiche Neuzuweisung den unresolved Eintrag; eine Deaktivierung entfernt nur den Readiness-Blocker. Sind alle anderen Bedingungen erfuellt, werden `/ready` und `/health` danach wieder gruen; Reaktivierung ohne Recovery oder Neuzuweisung blockiert erneut.
- [ ] Bei bereits vollstaendigen Court-Regelsnapshots blockiert eine stale oder temporaer nicht geladene Matchtyp-Tabelle allein `/ready` und `/health` nicht. Admin-`/status` zeigt ihren Tabellenzustand weiterhin, und eine neue Matchtyp-Zuweisung wird bis zu aktuellen Daten kontrolliert abgewiesen.
- [ ] Aenderungen einer Matchtyp-Zeile veraendern den persistierten `displayRules`-Snapshot einer laufenden Zuweisung nicht; erst eine erfolgreiche Neuzuweisung uebernimmt die dann aktuellen Regeln.
- [ ] Satz-Tie-Break in Satz 1/2 verschiebt die dritte Drehspalte ins Punktefeld und zeigt Satz 3 als 0; `MT7`/`MT10` markiert Satz 3 tuerkis.
- [ ] Zweistellige Werte in Satz 3 und Punktewerte wie 40 werden am Fernseher nicht abgeschnitten; der mobile Zurueck-Pfeil ist erreichbar und zentriert.
- [ ] Deaktivieren eines Platzes friert dessen letzten akzeptierten Score ein; spaete oder weitere externe Pollantworten dieses Platzes erzeugen keine Scoreaenderung und keine dadurch ausgeloeste Revision.
- [ ] Expliziter Nullreset setzt ausschliesslich den gewaehlten Platz sofort auf `0-0/0-0/0-0/0-0`, erhoeht Revision/Push genau einmal und bleibt fuer Abonnenten nach Resync sichtbar.
- [ ] Nach Aktivierung oder Nullreset wird der erste externe Stand nur als Baseline erfasst; ein unveraenderter Vorreset-Stand hebt den Nullreset nicht auf, erst eine spaetere semantische externe Aenderung wird uebernommen.
- [ ] Court-Epoch-Fencing wurde mit einer vor Deaktivierung, Reaktivierung oder Reset gestarteten und erst danach eintreffenden Pollantwort getestet; die alte Antwort wird verworfen.
- [ ] Eine akzeptierte externe Scoreaenderung erzeugt genau einen SQLite-ScoreLog-Eintrag mit Event-ID, Court-Folgenummer, Rohscore, Match-/Court-Kontext und UTC-Zeit; Freeze, Nullreset, Baseline und unveraenderte Polls erzeugen keinen Eintrag.
- [ ] Ein ScoreLog-Insertfehler veraendert den sichtbaren Score nicht, macht ScoreLog/Readiness erkennbar ungesund und wird mit unveraendertem Quellstand bei einem Folgepoll erneut versucht; nach Recovery wird genau ein Ereignis persistiert und angezeigt.
- [ ] Monitor-Enrollment mit Secure-Cookie funktioniert; Token erscheint danach weder in URL noch Storage/Logs.
- [ ] Navigator kann mehrere Monitore getrennt auswaehlen, navigieren und scrollen; Status durchlaeuft die erwarteten ACK-/Load-Zustaende.
- [ ] Monitorrotation und Revoke wirken sofort; Offline-, Timeout- und Terminalfehler sind sichtbar und korrekt korreliert.
- [ ] Sandboxed Candidate-/Active-iframes laden nur erlaubte same-origin Ziele.

## 10. Reconnect, Standby, BFCache und WLAN

- [ ] Kurzzeitiger WebSocket-Abbruch fuehrt zu Backoff mit Jitter, Reconnect, Welcome, Subscription-Wiederherstellung und Resync.
- [ ] Pending Requests werden bei Verbindungsverlust abgewiesen; Writes werden nicht blind automatisch wiederholt.
- [ ] Ein neu gestarteter RPC-Request wird bei bereits offline erkanntem Browserzustand sofort mit `OFFLINE` abgewiesen, ohne Socketaufbau oder Warten auf das Wiederverbindungsfenster.
- [ ] Ein bereits auf den Verbindungsaufbau wartender RPC-Request wird beim nachtraeglichen Offline-Ereignis sofort mit `OFFLINE` abgewiesen und wartet nicht bis zum Verbindungstimeout.
- [ ] Browser offline/online wurde getestet; UI meldet Offlinezustand und synchronisiert nach Rueckkehr.
- [ ] WLAN-Wechsel zwischen zwei Netzen und kurzzeitiger Paketverlust wurden auf Desktop, Mobil und Kiosk getestet.
- [ ] Geraete-Standby fuer kurze und laengere Zeit wurde getestet; Session, WSS, Scoreboard und Monitorstatus erholen sich kontrolliert.
- [ ] Tab im Hintergrund und Rueckkehr in den Vordergrund aktualisieren Verbindung, Session und zeitabhaengige Fachansichten.
- [ ] Vor-/Zurueck-Navigation aus dem BFCache (`pagehide/pageshow persisted`) erzeugt weder tote Sockets noch doppelte Subscriptions/Writes.
- [ ] Terminale WebSocket-Codes reconnecten nicht endlos; eine gueltige Monitor-Neuanmeldung kann kontrolliert neu verbinden.
- [ ] Ein serverseitiger 4406 mit App-Versionsgrund setzt tabbezogen den Session-Storage-Marker `epiber-app-version-reload` und loest genau einen automatischen Reload aus.
- [ ] Ein erfolgreiches Welcome entfernt `epiber-app-version-reload`. Tritt der App-Versions-4406 bei gesetztem Marker erneut auf, stoppt der Client terminal ohne weiteren Reload und ohne Reconnectschleife; bei nicht nutzbarem Session Storage wird ebenfalls nicht automatisch neu geladen.
- [ ] Ein generischer 4406, etwa wegen inkompatibler Protokollversion, ist terminal und erzeugt weder App-Update-Marker noch automatischen Reload oder Reconnectschleife; er wird nicht als App-Versionskonflikt gewertet.

## 11. Last, Dauerbetrieb und SIGTERM

- [ ] Erwartete Spitzenlast mit realistischer Mischung aus Browsern, Scoreboards, Monitoren, Reads, Subscriptions und erlaubten Writes getestet.
- [ ] Doppelte erwartete Spitzenlast getestet; Limits greifen kontrolliert, Prozess bleibt live und erholt sich ohne Neustart.
- [ ] Verbindungs-, Request-, Queue-, Speicher-, CPU- und Dateideskriptorverhalten waehrend Last beobachtet und dokumentiert.
- [ ] Courtquelle, Google-Sheets-Fehler/Timeout und Wiederherstellung getestet; Readiness und sichtbare Stale-/Fehlerzustaende sind korrekt.
- [ ] Ein kompletter Veranstaltungstag Dauerbetrieb auf PAJ ohne wachsende Ressourcen, Reconnectsturm, ungeklaerte Writes oder Datenabweichung absolviert.
- [ ] Kontrolliertes `systemctl stop epiber-paj` sendet SIGTERM, setzt `/live` auf stopping/503, lehnt neue Arbeit ab und schliesst WebSockets mit 1012.
- [ ] Poller/Timer stoppen, HTTP- und Sheets-Arbeit drainiert, alle drei SQLite-Datenbanken schliessen sauber und der Prozess endet innerhalb 90 Sekunden mit Exitcode 0.
- [ ] Neustart erhaelt vorgesehenen SQLite-State, Sessions/Monitore/Operationen, ScoreLog-Folgenummern und Audit-Historie gemaess Vertrag.
- [ ] Erzwungener Shutdown-Timeout wurde als Fehlerfall erkannt und nicht als erfolgreiche Abnahme gewertet.

## 12. `pendingMetadataIntents` manuell klaeren

- [ ] Bei `pendingMetadataIntents > 0` ist die Promotion sofort gestoppt; betroffene fachliche Aktion wird nicht wiederholt.
- [ ] Dienst und schreibende Benutzer werden fuer die Untersuchung angehalten; Spreadsheet und konsistenter SQLite-State werden erneut gesichert.
- [ ] Unter `app_state` werden die Schluessel `record-metadata-intent:<table>:<recordId>` mit Status `pending` durch eine berechtigte Person identifiziert. Keine Tokens oder Passwortdaten werden exportiert.
- [ ] Fuer jeden Intent wird in Google Sheets die fachliche Zeile anhand `<recordId>` und die Developer Metadata mit Key `epiberRecord` und Value `<table>:<recordId>` direkt geprueft.
- [ ] Auch die zugehoerige idempotente Operation und fachliche Auswirkung werden anhand stabiler Record-ID, Operationstatus und Sheet-Inhalt geprueft.
- [ ] Wenn genau eine passende Metadata an genau der richtigen Zeile existiert, wird deren Metadata-ID dokumentiert und der Intent nach Vier-Augen-Pruefung als bestaetigt aufgeloest.
- [ ] Wenn API-/Auditnachweis eindeutig zeigt, dass keine Metadata erstellt wurde, wird der Intent nach Vier-Augen-Pruefung als fehlgeschlagen aufgeloest; erst danach darf die normale Anwendung kontrolliert erneut versuchen.
- [ ] Wenn Existenz oder fachlicher Write-Ausgang nicht eindeutig beweisbar ist, bleibt der Intent pending, das System wird nicht promotet und die Klaerung wird eskaliert.
- [ ] Eine direkte SQLite-Korrektur erfolgt nur bei gestopptem Dienst, nach Backup, mit dokumentiertem Key/Metadata-ID und gepruefter Einzelanweisung. Es gibt keinen allgemeinen Massenreset und kein Loeschen aller Intents.
- [ ] Nach Neustart sind `/ready` gruen, `pendingMetadataIntents: 0`, Metadata und Zielzeile weiterhin eindeutig und der fachliche Zustand korrekt.
- [ ] Niemals einen unbekannten Google-Sheet-Write oder die urspruengliche Benutzeraktion blind wiederholen. Score-/Audithistorien werden ueber ihre SQLite-Event-/Request-IDs korreliert; sie ersetzen nicht die bestehende Fachwrite-Unknown-Klaerung.

## 13. Rollbackprobe

- [ ] Praktischer PAJ-Rollback auf den dokumentierten vorherigen Commit wurde durchgefuehrt, nicht nur theoretisch beschrieben.
- [ ] Vorherige Caddy-/systemd-Vorlagen, `.env`-Zuordnung und Credential-Zuordnung sind verfuegbar.
- [ ] Entscheidungskriterium dokumentiert, ob nur Code/Vorlagen oder wegen Inkompatibilitaet auch Sheets/SQLite zurueckgespielt werden muessen.
- [ ] Spreadsheet wird nur als vollstaendige konsistente Kopie zurueckgespielt; kein isolierter Tab-Rollback erzeugt Querverweisfehler.
- [ ] SQLite wird nur konsistent inklusive WAL-Zustand beziehungsweise aus Onlinebackup wiederhergestellt.
- [ ] Nach Rollback sind Version, `/live`, `/ready`, `/health`, Rollen, WSS, Monitor und Kerndaten geprueft.
- [ ] Rollbackdauer, Datenverlustfenster, Schritte und verantwortliche Person sind dokumentiert.

## 14. Promotion PAJ -> Live; PK bleibt deaktiviert

### PAJ

- [ ] Alle fuer die Anwendungsstufe geltenden Punkte 1 bis 6 und 8 bis 13 ohne offene Blocker abgeschlossen; die gemeinsame Observability aus Abschnitt 7 folgt erst nach Live.
- [ ] PAJ-Origin `https://epiber.at:8081` und WSS funktionieren ohne Zertifikatswarnung.
- [ ] PAJ-Journal und Adminstatus nach Abnahme unauffaellig; `pendingMetadataIntents: 0`.
- [ ] PAJ-Abnahme von verantwortlicher und zweiter pruefender Person signiert.

### PK, nicht Teil dieses Releases

- [ ] PK-Dienst und PK-Checkout wurden nicht veraendert oder gestartet.
- [ ] Prometheus, Alloy, Node Exporter, Auth-Broker, Dashboards und Anwendungsalerts beziehen PK nicht ein.
- [ ] Eine spaetere PK-Aktivierung wird als eigener Release mit Sheet-ID, Credential, Backup und vollstaendiger Abnahme durchgefuehrt.

### Live

- [ ] Live-Backup und Rollbackpunkt unmittelbar vor Deployment aktualisiert.
- [ ] Exakt derselbe auf PAJ freigegebene Commit und Lockfile-Hash installiert.
- [ ] Live-Sheet-ID und Live-Credential nochmals im Vier-Augen-Prinzip bestaetigt.
- [ ] Live-Origin `https://epiber.at`, WSS, Version, live/ready/health und Adminstatus erfolgreich.
- [ ] Kerndaten, Rollen/Login, Scoreboard, Court und mindestens ein Monitor ohne riskanten Testwrite geprueft.
- [ ] Logs, Status, Ressourcen, Reconnects und Sheets-Fehler waehrend des vereinbarten Nachbeobachtungsfensters aktiv ueberwacht.
- [ ] Nach erfolgreicher Live-Anwendungsabnahme wurde Abschnitt 7 vollstaendig ausgefuehrt und die gemeinsame Observability gesondert freigegeben.

## Erfolgskriterien

- [ ] Live und PAJ liefern exakt Version `<FREIGEGEBENE_VERSION>` und verwenden den identischen freigegebenen Commit; PK ist nicht Teil des Releases.
- [ ] Alle drei Systeme sind ausschliesslich ueber HTTPS/WSS erreichbar; Backends lauschen nur an Loopback.
- [ ] `/live`, `/ready` und `/health` sind stabil gruen; Adminstatus enthaelt keine Secrets, keine pending Metadata und keine aktiven unresolved Court-Regeln.
- [ ] Rollen- und Datenprojektionen werden serverseitig korrekt durchgesetzt.
- [ ] Keine falsche, doppelte oder verlorene fachliche Aenderung wurde in Sheets festgestellt.
- [ ] Google-Sheets-Tabs `Logging` und `ScoreLog` werden nicht mehr beschrieben; getrennte SQLite-Fachhistorien sind konsistent, gesichert und ohne Geheimnisse.
- [ ] Browser-, Kiosk-, Mobil-, Scoreboard-, Monitor-, Reconnect-, Standby-, BFCache- und WLAN-Matrix ist bestanden.
- [ ] Erwartete und doppelte Spitzenlast, Veranstaltungstag-Dauerbetrieb und kontrollierter SIGTERM sind bestanden.
- [ ] Praktischer Rollback ist innerhalb des dokumentierten Zeitfensters moeglich und getestet.
- [ ] Grafana ist zentral fuer aktuelle Admins aus Live und PAJ erreichbar; Prometheus und Loki enthalten getrennt filterbare Daten aus Live und PAJ ohne verbotene Labels und ohne aktives PK-Ziel.
- [ ] Nachbeobachtungsfenster abgeschlossen, keine offenen kritischen/hohen Fehler, Freigabe protokolliert.
- [ ] Das versionierte Freigabeprotokoll enthaelt keine Geheimnisse oder personenbezogenen Diagnosewerte und verweist nicht auf temporaere Dateien als dauerhafte Sicherung.
