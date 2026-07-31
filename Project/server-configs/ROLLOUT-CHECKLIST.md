# ePiber 4.1.3 Rollout-Checkliste

Stand: 31.07.2026

Diese Checkliste ist das verbindliche Gate fuer die Reihenfolge **PAJ -> PK -> Live**. Jede Stufe verwendet exakt denselben bestaetigten Release-Commit und dieselben versionierten Caddy-/systemd-Vorlagen. Abweichungen, offene Pflichtpunkte oder ein Branchsuffix in der Version stoppen die Promotion.

## Freigabeprotokoll

- [ ] Release-Commit: `____________________________`
- [ ] Verantwortliche Person: `____________________________`
- [ ] Zweite pruefende Person: `____________________________`
- [ ] Wartungsfenster und Kommunikationsweg festgelegt.
- [ ] Vorheriger freigegebener Commit/Release fuer Rollback notiert: `____________________________`
- [ ] `Backend/package.json`, `Backend/package-lock.json` und Release-Commit melden exakt `4.1.3`.
- [ ] `git status` des Deploymentstands ist sauber; keine lokalen Code-/Vorlagenaenderungen werden ausgerollt.

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
- [ ] `Logging` bleibt exakt dreispaltig: `Timestamp`, `Type`, `Message`.
- [ ] `ScoreLog` bleibt exakt dreispaltig: `Timestamp`, `PlatzNr`, `Score`.
- [ ] Keine `EventID`-Spalte und keine Event-ID-, Retry-, Readback- oder Pending-Migration fuer `Logging` oder `ScoreLog` angelegt.
- [ ] Insbesondere keine SQLite-`ScoreLog`-Queue, kein `scoreLogPending` und keine ScoreLog-Pending-Abnahme erwartet. ScoreLog bleibt Fire-and-forget.
- [ ] Eindeutige, nichtleere IDs und eindeutige Personen-E-Mail-Adressen stichprobenartig beziehungsweise automatisiert geprueft.
- [ ] Schreibrechte auf `Personen`, `Matches1`, `EntryList`, `Logging` und `ScoreLog` praktisch mit dem vorgesehenen Service-Account bestaetigt.

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
- [ ] `npm --version` meldet npm 12.0.1.
- [ ] `package-lock.json` ist versioniert, unveraendert und Lockfile-Version 3.
- [ ] Im `Backend/` des Releasecheckouts ist `npm ci --omit=dev` erfolgreich.
- [ ] `npm run build` ist erfolgreich; statischer Check und vollstaendige Testsuite sind gruen.
- [ ] `npm audit --omit=dev` meldet keine nicht akzeptierte Produktionsluecke.
- [ ] `caddy validate --config /etc/caddy/Caddyfile` ist mit der installierten 4.1.3-Vorlage erfolgreich.
- [ ] Alle drei installierten Units bestehen `systemd-analyze verify`.
- [ ] Caddy proxyt nur `/ws`, `/api/*`, `/live`, `/ready`, `/health`, `/version`, `/status` auf die systemspezifischen Loopbackports.
- [ ] Caddy-Roots zeigen exakt auf die jeweiligen `Frontend/`-Verzeichnisse; Backend, `.env`, Credentials und SQLite sind nicht statisch erreichbar.
- [ ] CSP und Security-Header sind vorhanden; alle drei Origins und WebSockets verwenden HTTPS/WSS ohne Mixed Content.
- [ ] Es existiert keine systemspezifische `SDK.js`; der Browser verbindet same-origin auf `/ws`.
- [ ] Beobachtete WebSocket-Schliesscodes und Reconnectentscheidungen stimmen mit `Project/software/WEBSOCKET-CLOSE-CODES.txt` ueberein.

## 5. systemd, SQLite und Prozessgrenzen

- [ ] User, WorkingDirectory, `.env`, Credentialquelle und `INSTANCE_ID` stimmen je System.
- [ ] `LISTEN_HOST=127.0.0.1`; Node lauscht Live auf 8080, PAJ auf 8083 und PK auf 8084 nur an Loopback.
- [ ] `PUBLIC_ORIGIN` ist Live `https://epiber.at`, PAJ `https://epiber.at:8081`, PK `https://epiber.at:8082`.
- [ ] `STATE_FILE` ist `/var/lib/epiber-<system>/state.sqlite`.
- [ ] `StateDirectory=epiber-<system>`, Verzeichnismodus 0700, SQLite-Modus 0600 und `UMask=0077` bestaetigt.
- [ ] SQLite verwendet Foreign Keys, WAL und `synchronous=FULL`; Dateisystem hat ausreichend freien Platz.
- [ ] Konsistentes SQLite-Backup erstellt. Bei gestopptem Dienst wurden DB, WAL und SHM gemeinsam behandelt; alternativ wurde ein SQLite-Onlinebackup verwendet.
- [ ] Sandbox und leere Capability-Sets entsprechen der Vorlage; es wurden keine pauschalen Schreib- oder Home-Ausnahmen hinzugefuegt.
- [ ] `KillSignal=SIGTERM`, `SHUTDOWN_GRACE_MS=90000` und `TimeoutStopSec=95` stimmen zusammen.

## 6. Health, Status und Transport

- [ ] `/version` liefert HTTP 200 und exakt Version `4.1.3`.
- [ ] `/live` liefert HTTP 200 mit `status: ok`.
- [ ] `/ready` und `/health` liefern nach Initialisierung HTTP 200 mit `status: ready`.
- [ ] Anonymes `/status` wird mit 401 abgewiesen.
- [ ] Admin-`/status` zeigt plausible Tabellenalter, Poller, Courtquelle, Provider, Monitor-, SQLite- und Sheets-Zustaende.
- [ ] Admin-`/status` enthaelt keine Cookies, Tokens, Passwortwerte, privaten Schluessel oder `.env`-Secrets.
- [ ] `pendingMetadataIntents` ist 0; es gibt und braucht keinen `scoreLogPending`-Wert.
- [ ] Browser-DevTools zeigen HTTPS, WSS-101-Upgrade auf same-origin `/ws`, Hello/Welcome-Protokoll v2 und keine CSP-, Zertifikats-, Origin- oder Mixed-Content-Fehler.
- [ ] Externe Firewall erlaubt 80, 443, 8081 und 8082; Backendports 8080, 8083 und 8084 sind extern nicht erreichbar.

## 7. Rollen und Fachfunktionen auf PAJ

- [ ] Anonymous sieht nur oeffentliche Daten/Profile und kann keine geschuetzten Writes ausfuehren.
- [ ] `player` kann sich anmelden/abmelden, eigenes Profil und Mitgliederprofil sehen, eigenes Passwort aendern, Forderung und EntryList fachregelkonform bedienen.
- [ ] `operator` kann zusaetzlich Navigator und Courtsteuerung bedienen, aber keine Admin-Monitorverwaltung oder fremde Passwortsetzung.
- [ ] `admin` kann Resetnachweis erzeugen, Passwort direkt setzen sowie Monitore provisionieren, rotieren und widerrufen.
- [ ] Nur `admin` kann ueber `POST /api/admin/password-setup` die Erstvergabe freigeben oder aufheben; Profilanzeige und Sheetwert `KennwortVergessen` wechseln dabei konsistent zwischen `x` und leer.
- [ ] `POST /api/password-setup` akzeptiert nur E-Mail plus neues Passwort einer aktiven, mit `KennwortVergessen = x` freigegebenen Person; unbekannte, inaktive, nicht freigegebene und nachtraeglich deaktivierte Personen werden ohne Passwortwrite abgewiesen.
- [ ] Erfolgreiche Erstvergabe verbraucht die Freigabe atomar: `KennwortVergessen` ist danach leer und ein zweiter Setupversuch wird abgewiesen.
- [ ] Aktivstatus und Freigabe werden auch bei einem konkurrierenden Aenderungsversuch unmittelbar vor dem Setup-Write erneut geprueft.
- [ ] Erstvergabe widerruft alle bestehenden Sitzungen der Zielperson vor und nach dem Write; offene Tabs wechseln in den abgemeldeten Zustand und das alte Passwort funktioniert nicht mehr.
- [ ] Falsche Rolle, abgelaufene/ungueltige Session und widerrufenes Monitorgeraet werden serverseitig abgewiesen.
- [ ] Passwortaenderung/-reset widerruft die vorgesehenen Sitzungen; Cross-Tab Login/Logout bleibt konsistent.
- [ ] Personenprofile zeigen anonym nur ID/Name und angemeldet die vorgesehenen Kontakt-/Geburtsdaten; Adminaktionen sind nur fuer Admin sichtbar und wirksam.
- [ ] Login, eigene Passwortaenderung und Erstvergabe funktionieren mit mindestens einem freigegebenen Browser-Passwortmanager; `username`, `current-password`, `new-password` und `one-time-code` werden passend erkannt, ohne Passwortwerte in URL, Logs oder Storage zu schreiben.
- [ ] Login-, Passwortaenderungs-, Reset-, Erstvergabe- und Admin-Passwortmodale schliessen nicht durch Backdropklick oder Escape, sondern nur explizit ueber Abbrechen/Schliessen; waehrend eines Requests sind Schliessen und Doppel-Submit gesperrt, danach werden Formulare und sichtbare Passwoerter zurueckgesetzt.
- [ ] Matches/Forderungen, EntryList Add/Remove, Ranglistenrestriktionen und Loggingwrite wurden mit realistischen Daten geprueft.
- [ ] Unklare fachliche Writes werden als `unknown` behandelt und nicht automatisch erneut ausgefuehrt.

## 8. Browser, Kiosk, Monitor und Scoreboards auf PAJ

- [ ] Aktuelle freigegebene Browser auf Desktop und Mobilgeraeten getestet.
- [ ] Mobile Navigation oeffnet ueber den Hamburger, zeigt je Sessionzustand korrekt Anmelden oder Profil/Abmelden sowie `Spieler` nur angemeldet und schliesst bei Navigation beziehungsweise Authaktion ohne verdecktes Folgemodal.
- [ ] Mobile Navigation wurde mit Touch, Tastatur, schmalem Hochformat und kleinem Querformat getestet; Links, Schliessen, Fokus und Scrollen bleiben erreichbar und es entstehen keine doppelten Authaktionen.
- [ ] `players.html` zeigt anonym die Anmeldeaufforderung und angemeldet die erlaubte Spielerliste; Authwechsel, Invalidierung, Leerzustand und Fehlerzustand rendern ohne alte oder fremde Profildaten.
- [ ] `bewerbsRaster.html?id=...` rendert Einzel und Doppel, BYE, `[w.o.]`, `[ret]`, `[gesetzt]`, Ergebnisse und Gewinner korrekt; fehlende/ungueltige Bewerb-ID, leere Daten, Reload, Authwechsel und Topic-Invalidierung wurden geprueft.
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
- [ ] Bereits vor dem Rollout gespeicherte laufende Court-Zuweisungen wurden einmal neu zugewiesen und enthalten danach eine `matchtypId`.
- [ ] Satz-Tie-Break in Satz 1/2 verschiebt die dritte Drehspalte ins Punktefeld und zeigt Satz 3 als 0; `MT7`/`MT10` markiert Satz 3 tuerkis.
- [ ] Zweistellige Werte in Satz 3 und Punktewerte wie 40 werden am Fernseher nicht abgeschnitten; der mobile Zurueck-Pfeil ist erreichbar und zentriert.
- [ ] Deaktivieren eines Platzes friert dessen letzten akzeptierten Score ein; spaete oder weitere externe Pollantworten dieses Platzes erzeugen keine Scoreaenderung und keine dadurch ausgeloeste Revision.
- [ ] Expliziter Nullreset setzt ausschliesslich den gewaehlten Platz sofort auf `0-0/0-0/0-0/0-0`, erhoeht Revision/Push genau einmal und bleibt fuer Abonnenten nach Resync sichtbar.
- [ ] Nach Aktivierung oder Nullreset wird der erste externe Stand nur als Baseline erfasst; ein unveraenderter Vorreset-Stand hebt den Nullreset nicht auf, erst eine spaetere semantische externe Aenderung wird uebernommen.
- [ ] Court-Epoch-Fencing wurde mit einer vor Deaktivierung, Reaktivierung oder Reset gestarteten und erst danach eintreffenden Pollantwort getestet; die alte Antwort wird verworfen.
- [ ] Eine akzeptierte externe Scoreaenderung erzeugt genau einen dreispaltigen `ScoreLog`-Append (`Timestamp`, `PlatzNr`, `Score`); Freeze, Nullreset, Baseline und unveraenderte Polls erzeugen keinen Eintrag.
- [ ] ScoreLog-Fehler veraendern den sichtbaren Score nicht und loesen weder Retry noch SQLite-/Pendingstatus aus; erfolgreicher Wiederanlauf schreibt erst die naechste semantische Aenderung.
- [ ] Monitor-Enrollment mit Secure-Cookie funktioniert; Token erscheint danach weder in URL noch Storage/Logs.
- [ ] Navigator kann mehrere Monitore getrennt auswaehlen, navigieren und scrollen; Status durchlaeuft die erwarteten ACK-/Load-Zustaende.
- [ ] Monitorrotation und Revoke wirken sofort; Offline-, Timeout- und Terminalfehler sind sichtbar und korrekt korreliert.
- [ ] Sandboxed Candidate-/Active-iframes laden nur erlaubte same-origin Ziele.

## 9. Reconnect, Standby, BFCache und WLAN

- [ ] Kurzzeitiger WebSocket-Abbruch fuehrt zu Backoff mit Jitter, Reconnect, Welcome, Subscription-Wiederherstellung und Resync.
- [ ] Pending Requests werden bei Verbindungsverlust abgewiesen; Writes werden nicht blind automatisch wiederholt.
- [ ] Browser offline/online wurde getestet; UI meldet Offlinezustand und synchronisiert nach Rueckkehr.
- [ ] WLAN-Wechsel zwischen zwei Netzen und kurzzeitiger Paketverlust wurden auf Desktop, Mobil und Kiosk getestet.
- [ ] Geraete-Standby fuer kurze und laengere Zeit wurde getestet; Session, WSS, Scoreboard und Monitorstatus erholen sich kontrolliert.
- [ ] Tab im Hintergrund und Rueckkehr in den Vordergrund aktualisieren Verbindung, Session und zeitabhaengige Fachansichten.
- [ ] Vor-/Zurueck-Navigation aus dem BFCache (`pagehide/pageshow persisted`) erzeugt weder tote Sockets noch doppelte Subscriptions/Writes.
- [ ] Terminale WebSocket-Codes reconnecten nicht endlos; eine gueltige Monitor-Neuanmeldung kann kontrolliert neu verbinden.

## 10. Last, Dauerbetrieb und SIGTERM

- [ ] Erwartete Spitzenlast mit realistischer Mischung aus Browsern, Scoreboards, Monitoren, Reads, Subscriptions und erlaubten Writes getestet.
- [ ] Doppelte erwartete Spitzenlast getestet; Limits greifen kontrolliert, Prozess bleibt live und erholt sich ohne Neustart.
- [ ] Verbindungs-, Request-, Queue-, Speicher-, CPU- und Dateideskriptorverhalten waehrend Last beobachtet und dokumentiert.
- [ ] Courtquelle, Google-Sheets-Fehler/Timeout und Wiederherstellung getestet; Readiness und sichtbare Stale-/Fehlerzustaende sind korrekt.
- [ ] Ein kompletter Veranstaltungstag Dauerbetrieb auf PAJ ohne wachsende Ressourcen, Reconnectsturm, ungeklaerte Writes oder Datenabweichung absolviert.
- [ ] Kontrolliertes `systemctl stop epiber-paj` sendet SIGTERM, setzt `/live` auf stopping/503, lehnt neue Arbeit ab und schliesst WebSockets mit 1012.
- [ ] Poller/Timer stoppen, HTTP- und Sheets-Arbeit drainiert, SQLite schliesst sauber und der Prozess endet innerhalb 90 Sekunden mit Exitcode 0.
- [ ] Neustart erhaelt vorgesehenen SQLite-State, Sessions/Monitore/Operationen gemaess Vertrag und konsistente Court-/Navigatorwerte.
- [ ] Erzwungener Shutdown-Timeout wurde als Fehlerfall erkannt und nicht als erfolgreiche Abnahme gewertet.

## 11. `pendingMetadataIntents` manuell klaeren

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
- [ ] Niemals einen unbekannten Append oder die urspruengliche Benutzeraktion blind wiederholen. Besonders `Logging` und `ScoreLog` besitzen keine Event-ID-/Readbackgarantie; fuer ScoreLog existiert kein Pending-Mechanismus.

## 12. Rollbackprobe

- [ ] Praktischer PAJ-Rollback auf den dokumentierten vorherigen Commit wurde durchgefuehrt, nicht nur theoretisch beschrieben.
- [ ] Vorherige Caddy-/systemd-Vorlagen, `.env`-Zuordnung und Credential-Zuordnung sind verfuegbar.
- [ ] Entscheidungskriterium dokumentiert, ob nur Code/Vorlagen oder wegen Inkompatibilitaet auch Sheets/SQLite zurueckgespielt werden muessen.
- [ ] Spreadsheet wird nur als vollstaendige konsistente Kopie zurueckgespielt; kein isolierter Tab-Rollback erzeugt Querverweisfehler.
- [ ] SQLite wird nur konsistent inklusive WAL-Zustand beziehungsweise aus Onlinebackup wiederhergestellt.
- [ ] Nach Rollback sind Version, `/live`, `/ready`, `/health`, Rollen, WSS, Monitor und Kerndaten geprueft.
- [ ] Rollbackdauer, Datenverlustfenster, Schritte und verantwortliche Person sind dokumentiert.

## 13. Promotion PAJ -> PK -> Live

### PAJ

- [ ] Alle Punkte 1 bis 12 ohne offene Blocker abgeschlossen.
- [ ] PAJ-Origin `https://epiber.at:8081` und WSS funktionieren ohne Zertifikatswarnung.
- [ ] PAJ-Journal und Adminstatus nach Abnahme unauffaellig; `pendingMetadataIntents: 0`.
- [ ] PAJ-Abnahme von verantwortlicher und zweiter pruefender Person signiert.

### PK

- [ ] Exakt derselbe Release-Commit, Lockfile-Hash und Vorlagenstand wie auf PAJ installiert.
- [ ] PK-Sheet-ID, Credential-Datei und Backup separat bestaetigt; keine PAJ-/Live-Zuordnung versehentlich verwendet.
- [ ] PK-Origin `https://epiber.at:8082`, WSS, Version, live/ready/health, Adminstatus, Rollen, ein kontrollierter Read/Write und Monitor-Smoke-Test erfolgreich.
- [ ] PK mindestens fuer das vereinbarte Beobachtungsfenster ohne neue Fehler oder pending Metadata betrieben.
- [ ] PK-Freigabe signiert.

### Live

- [ ] Live-Backup und Rollbackpunkt unmittelbar vor Deployment aktualisiert.
- [ ] Exakt derselbe auf PAJ und PK freigegebene Commit und Lockfile-Hash installiert.
- [ ] Live-Sheet-ID und Live-Credential nochmals im Vier-Augen-Prinzip bestaetigt.
- [ ] Live-Origin `https://epiber.at`, WSS, Version, live/ready/health und Adminstatus erfolgreich.
- [ ] Kerndaten, Rollen/Login, Scoreboard, Court und mindestens ein Monitor ohne riskanten Testwrite geprueft.
- [ ] Logs, Status, Ressourcen, Reconnects und Sheets-Fehler waehrend des vereinbarten Nachbeobachtungsfensters aktiv ueberwacht.

## Erfolgskriterien

- [ ] Alle drei Systeme liefern exakt Version `4.1.3` und verwenden den identischen freigegebenen Commit.
- [ ] Alle drei Systeme sind ausschliesslich ueber HTTPS/WSS erreichbar; Backends lauschen nur an Loopback.
- [ ] `/live`, `/ready` und `/health` sind stabil gruen; Adminstatus enthaelt keine Secrets und keine pending Metadata.
- [ ] Rollen- und Datenprojektionen werden serverseitig korrekt durchgesetzt.
- [ ] Keine falsche, doppelte oder verlorene fachliche Aenderung wurde in Sheets festgestellt.
- [ ] `Logging` und `ScoreLog` sind unveraendert dreispaltig; keine Event-ID-/Pending-Migration wurde eingefuehrt.
- [ ] Browser-, Kiosk-, Mobil-, Scoreboard-, Monitor-, Reconnect-, Standby-, BFCache- und WLAN-Matrix ist bestanden.
- [ ] Erwartete und doppelte Spitzenlast, Veranstaltungstag-Dauerbetrieb und kontrollierter SIGTERM sind bestanden.
- [ ] Praktischer Rollback ist innerhalb des dokumentierten Zeitfensters moeglich und getestet.
- [ ] Nachbeobachtungsfenster abgeschlossen, keine offenen kritischen/hohen Fehler, Freigabe protokolliert.
