# ePiber Backup- und Restore-Konzept

Stand: 23.08.2026

## 1. Zweck und Status

Dieses Dokument beschreibt das Zielkonzept fuer Sicherung, Wiederherstellung und
Disaster Recovery der ePiber-Systeme. Es umfasst die aktiven Instanzen Live
(`piber`) und PAJ sowie die vorbereitete, derzeit deaktivierte Instanz PK.

Das Dokument ist ein Sollkonzept. Es bestaetigt nicht, dass die beschriebenen
Timer, Backupziele, Berechtigungen, Restorewerkzeuge oder Alarmierungen bereits
installiert oder betriebsbereit sind. Der installierte Zustand muss vor jeder
Freigabe separat geprueft und protokolliert werden.

Ziele des Konzepts sind:

- fachliche und technische Datenverluste auf freigegebene Zeitfenster begrenzen;
- Anwendung, Konfiguration und Daten nach logischer Korruption, Hostausfall oder
  Sicherheitsvorfall kontrolliert wiederherstellen;
- Google Sheets und die lokalen SQLite-Systeme konsistent behandeln;
- Sicherungen gegen versehentliche Loeschung, Hostverlust und Angriffe schuetzen;
- die Wiederherstellbarkeit regelmaessig praktisch nachweisen;
- personenbezogene Daten und Geheimnisse auch in Sicherungen angemessen schuetzen;
- Verantwortlichkeiten, Freigaben und Nachweise nachvollziehbar festlegen.

Dieses Konzept ergaenzt `Project/server-configs/SERVER-SETUP.txt`,
`Project/server-configs/ROLLOUT-CHECKLIST.md`,
`Project/server-configs/SERVER-DOKU.txt`,
`Project/software/ARCHITEKTUR.txt` und `Project/software/DATENBANK.txt`.
Bei Widerspruechen zum aktuellen Laufzeitverhalten ist der Code massgeblich; die
Abweichung muss vor der naechsten Betriebsfreigabe geklaert werden.

## 2. Begriffe

| Begriff | Bedeutung |
|---|---|
| Backup | Vom Quellsystem getrennte, pruefbare Sicherung von Daten und Metadaten |
| Snapshot | Technischer Zustand zu einem Zeitpunkt; nicht automatisch ein unabhaengiges Backup |
| RPO | Maximal akzeptierter Datenverlust, gemessen als Zeit seit dem letzten nutzbaren Sicherungspunkt |
| RTO | Maximal akzeptierte Zeit bis zur Wiederherstellung des vereinbarten Betriebsumfangs |
| Hot-Backup | Sicherung bei laufendem Dienst ohne globalen Write-Stopp |
| Konsistenter Sicherungspunkt | Zusammengehoeriger Satz nach kontrolliertem Drain und Ausschluss weiterer Writes |
| Off-host | Physisch oder logisch ausserhalb des Anwendungsservers gespeichert |
| Off-site | Ausserhalb des Serverstandorts beziehungsweise bei einem unabhaengigen Storageanbieter gespeichert |
| Immutable | Fuer eine definierte Frist nicht aender- oder loeschbar |
| Restoretest | Praktische Wiederherstellung mit technischer und fachlicher Validierung |
| DR | Disaster Recovery nach Host-, Standort- oder Sicherheitsausfall |

## 3. Verifizierter Ausgangsstand

### 3.1 Vorhandene Grundlagen

- Google Sheets ist die autoritative Quelle fuer operative Fach- und Stammdaten.
- `state.sqlite` enthaelt lokalen Sicherheits-, Steuerungs-, Idempotenz- und
  Recovery-State.
- `scorelog.sqlite` und `audit.sqlite` sind getrennte Systems of Record fuer die
  dauerhafte Score- beziehungsweise Audithistorie.
- Alle drei ePiber-SQLite-Datenbanken verwenden WAL, Foreign Keys,
  `synchronous=FULL` und restriktive Dateirechte.
- Der Backend-Shutdown stoppt neue Arbeit, drainiert HTTP-, WebSocket- und
  Google-Sheets-Arbeit und schliesst danach die SQLite-Datenbanken.
- Die Rollout-Checkliste verlangt vollstaendige Sheet-Kopien und konsistente
  SQLite-Sicherungen vor relevanten Aenderungen.
- Ein fuer Version 4.4.2 dokumentierter Sicherungssatz enthielt sechs
  Anwendungs-SQLite-Dateien, Grafana-SQLite, die Grafana-Secretdatei und lokale
  Pruefsummen. Alle sieben SQLite-Dateien bestanden `PRAGMA integrity_check`.

### 3.2 Bekannte Luecken

- Im Repository existiert kein automatisiertes Backup- oder Restorewerkzeug.
- Es existieren keine versionierten ePiber-Backup-Services oder systemd-Timer.
- Der dokumentierte 4.4.2-Sicherungssatz liegt auf demselben Host und ist kein
  Off-host- oder Disaster-Recovery-Backup.
- Es sind keine verbindlichen RPO-/RTO-Werte abgenommen.
- Es gibt keinen automatisierten Restoretest und keine Backupalter-Ueberwachung.
- Google Sheets und die drei SQLite-Datenbanken besitzen keine gemeinsame
  Transaktion.
- `scorelog.sqlite` und `audit.sqlite` wachsen ohne automatische fachliche
  Bereinigung.
- Grafana wertet Alerts aus, besitzt aber keinen aktiven Benachrichtigungsweg.
- Eine lokale, von Git ignorierte `.env.bak` wurde festgestellt. Inhalt, Zweck,
  Schutz, Rotation und Loeschung sind nicht definiert; der Inhalt wurde fuer die
  Analyse nicht gelesen.

### 3.3 Hostbeobachtung vom 16.08.2026

- Die gepruefte Timerliste enthielt keinen ePiber-Backup-Timer.
- `sqlite3` und `gpg` waren vorhanden; `restic`, `borg`, `rclone` und `age`
  wurden nicht gefunden.
- `/`, `/var` und `/srv` lagen auf demselben Dateisystem. Ein anderes Verzeichnis
  auf diesem Dateisystem ist daher kein unabhaengiges Backupmedium.
- Das dokumentierte Verzeichnis `/var/backups/epiber` war fuer den unprivilegierten
  Pruefbenutzer nicht lesbar und konnte inhaltlich nicht unabhaengig bestaetigt
  werden. Root-only-Zugriff ist beabsichtigt, ersetzt aber keinen Betriebsnachweis.
- Der Git-Checkout war sauber und besass ein GitHub-Remote. Git sichert jedoch
  keine lokalen Datenbanken, Geheimnisse oder nicht versionierte Konfiguration.

## 4. Schutzobjekte und Schutzklassen

### 4.1 Klasse A: Kritische Systems of Record

| Schutzobjekt | Ort | Inhalt und Wiederherstellungsbedeutung |
|---|---|---|
| Live-Spreadsheet | Google Drive/Sheets, ID laut `SERVER-DOKU.txt` | Autoritative Live-Fach- und Stammdaten, Rollen, Passwort-Hashes, Matches, Ranglisten und Anmeldungen |
| PAJ-Spreadsheet | Google Drive/Sheets, ID laut `SERVER-DOKU.txt` | Autoritative Test- und Abnahmedaten |
| PK-Spreadsheet | Vor Aktivierung festzulegen | Kuenftige PK-Fachdaten; vorher kein produktiver Schutzumfang |
| Developer Metadata | In den Spreadsheets | `epiberRecord`-Zuordnung fuer sichere Updates und Deletes; muss zusammen mit den Sheetdaten wiederherstellbar sein |
| `audit.sqlite` | `/var/lib/epiber-<system>/audit.sqlite` | Dauerhafte Fach-, Security-, Court- und Monitoraudits, einschliesslich vollstaendiger normalisierter gueltiger Loginversuche und Quell-IPs sowie weiterer geschuetzter personenbezogener Daten |
| `scorelog.sqlite` | `/var/lib/epiber-<system>/scorelog.sqlite` | Dauerhafte Court-Scorehistorie und Folgenummern |

### 4.2 Klasse B: Kritischer Betriebs- und Recovery-State

| Schutzobjekt | Ort | Inhalt und Wiederherstellungsbedeutung |
|---|---|---|
| `state.sqlite` | `/var/lib/epiber-<system>/state.sqlite` | Court-/Monitor-State, Sessions, Resetnachweise, Token-Hashes, Operationen, Loginlimits und Metadata-Intents |
| `.env` | Je Checkout unter `Backend/.env` | Systemspezifische Sheet-ID, Court-URL, Port und optionale Betriebsgrenzen |
| Service-Account-Quelldateien | Root-only-Pfade laut `SERVER-DOKU.txt` | Google-API-Identitaeten; nach Kompromittierung nicht restaurieren, sondern neu ausstellen |
| Grafana-DB | `/var/lib/grafana/grafana.db` | Grafana-Benutzer, lokaler Zustand und Alert-History |
| Grafana-Secretdatei | `/etc/epiber-observability/grafana.env` | Break-glass-Passwort und Secret-Key; muss zur Grafana-DB passen |

### 4.3 Klasse C: Reproduzierbare Konfiguration und Software

- Git-Repository und freigegebener Commit
- `Backend/package.json` und `Backend/package-lock.json`
- installierte Caddy-Konfiguration
- installierte systemd-Units
- journald-Drop-in
- Grafana-, Loki-, Prometheus-, Alloy- und Node-Exporter-Konfiguration
- tmpfiles-Konfiguration
- Liste der benoetigten Betriebssystempakete und Versionen
- Benutzer, Gruppen, Dateirechte, Firewall- und Netzwerkregeln
- DNS- und Zertifikatsverfahren
- Google-IAM- und Drive-Freigaben ohne private Schluesselinhalte

Versionierte Vorlagen sind primaer aus Git wiederherzustellen. Zusaetzlich muss
ein Manifest des tatsaechlich installierten Standes vorhanden sein, weil
versionierter Sollstand und Host-Iststand voneinander abweichen koennen.

### 4.4 Klasse D: Diagnosedaten

- Loki unter `/var/lib/loki`
- Prometheus unter `/var/lib/prometheus`
- persistentes journald
- rotierte Caddy-Access-Logs

Diese Daten sind keine ePiber-Systems of Record. Sie werden standardmaessig nicht
in die langfristige Fachdatensicherung aufgenommen. Falls rechtliche, forensische
oder betriebliche Anforderungen eine Sicherung verlangen, ist dafuer eine eigene
kurze Retention mit Datenschutzpruefung festzulegen.

### 4.5 Nicht direkt sicherbare oder nicht zu rekonstruierende Daten

- Die acht aktuellen Scorewerte liegen nur im Prozessspeicher. Nach einem
  Backendneustart wird ein aktiver Court aus der externen Quelle aufgebaut.
- `scorelog.sqlite` ist Historie und wird nicht zur Rekonstruktion des sichtbaren
  Live-Scores gelesen.
- Lesbare Monitor-Cookies liegen nur auf den Monitorgeraeten. Serverseitig werden
  ausschliesslich Token-Hashes gespeichert. Bei Verlust ist eine kontrollierte
  Neu-Provisionierung erforderlich.
- Die temporaere systemd-`LoadCredential`-Kopie ist kein Backupobjekt. Massgeblich
  ist die root-kontrollierte Quelldatei oder ein neu ausgestellter Schluessel.
- In-Memory-Sheet-Caches werden beim Start neu aufgebaut und nicht gesichert.

## 5. Risikobewertung

### 5.1 Kritische Risiken

#### Gemeinsamer Ausfallbereich

Produktion, SQLite-Dateien und der dokumentierte lokale Sicherungssatz liegen auf
demselben Host. Hostverlust, Root-Kompromittierung, Ransomware, Controller- oder
Dateisystemschaden koennen Quelle und Sicherung gleichzeitig treffen.

#### Fehlende Automatisierung

Manuelle Rolloutbackups decken weder laufende Aenderungen noch unbemerkte
Korruption zwischen Releases ab. Ausbleibende Sicherungen koennen ohne technische
Kontrolle unentdeckt bleiben.

#### Fehlende verteilte Transaktion

Google Sheets, `state.sqlite`, `scorelog.sqlite` und `audit.sqlite` werden nicht
atomar als Gesamtsystem geschrieben. Ein unkoordiniertes Backup kann einen
Sheetwrite enthalten, waehrend die zugehoerige Operation, ein Metadata-Intent
oder der Auditabschluss aus einem anderen Zeitpunkt stammt.

#### Ungepruefte Wiederherstellbarkeit

Eine lesbare Datei oder erfolgreiche Pruefsumme beweist keine fachlich korrekte
Wiederherstellung. Insbesondere Sheet-Querverweise, Developer Metadata,
Operationen, Sequenzen, Rollen und Rechte muessen nach einem Restore praktisch
validiert werden.

### 5.2 Hohe Risiken

#### Reaktivierung alter Sicherheitszustaende

Ein Restore von `state.sqlite` kann nach dem Backup widerrufene Sessions,
Resetnachweise oder Monitorgeraete wiederherstellen. Ein Restore ohne
Sicherheitsbereinigung kann damit alte Zugriffsmoeglichkeiten reaktivieren.

#### Unvollstaendige Google-Exporte

CSV- oder XLSX-Exporte sind keine vollstaendigen ePiber-Sicherungen. Developer
Metadata, Freigaben, Dateieigenschaften, Validierungen oder andere Strukturen
koennen fehlen. Die Erhaltung von `epiberRecord` ist separat zu pruefen.

#### Unbegrenztes Datenwachstum

Score- und Audithistorie werden fachlich nicht automatisch bereinigt. Ein volles
Dateisystem kann Anwendung und Backups beeintraechtigen. Backupgenerationen
vervielfachen ausserdem die personenbezogenen Auditdaten.

#### Fehlende aktive Alarmierung

Backupfehler duerfen nicht ausschliesslich durch gelegentliche manuelle
Grafana-Kontrolle erkannt werden. Ein unabhaengiger Benachrichtigungsweg ist fuer
kritische Sicherungsfehler erforderlich.

#### Geheimnisse und unkontrollierte Kopien

Backups von `.env`, Service-Account-Dateien und Grafana-Secrets besitzen einen
hohen Schutzbedarf. Ad-hoc-Dateien wie `.env.bak` umgehen definierte Retention,
Verschluesselung und Zugriffskontrolle.

### 5.3 Mittlere Risiken

- kein atomarer Anwendungsdeploy und kein automatisches Zurueckschalten;
- keine verbindliche Retention fuer `/var/backups/epiber`;
- keine standardisierte Export- oder Restore-CLI;
- keine Messung von tatsaechlicher Backupgroesse und Aenderungsrate;
- Abhaengigkeit von Google-Konto, Drive-Freigaben und Service-Account-IAM;
- keine vollstaendige, getestete Host-Build-Anweisung fuer einen leeren Ersatzhost.

## 6. Vorgeschlagene Wiederherstellungsziele

Die folgenden Werte sind ein belastbarer Ausgangspunkt. Sie werden erst nach
fachlicher Freigabe verbindlich.

| Schutzumfang | Vorgeschlagenes RPO | Vorgeschlagenes RTO |
|---|---:|---:|
| SQLite State, Audit und Score waehrend des Betriebs | 15 Minuten | 2 Stunden |
| Google Sheets waehrend einer Veranstaltung | 1 Stunde | 2 Stunden |
| Google Sheets ausserhalb einer Veranstaltung | 4 Stunden | 4 Stunden |
| Naechtlicher fachlich konsistenter Gesamtsatz | 24 Stunden | 4 Stunden |
| Konfiguration und Geheimnisse | Nach jeder Aenderung, hoechstens 24 Stunden | 4 Stunden |
| Vollstaendiger Hostverlust | Kleinstes verfuegbares RPO der Fachdaten | 8 Stunden |
| Verlust des gesamten Standorts oder Primaranbieters | 24 Stunden | 24 Stunden |
| Grafana-Zustand | 24 Stunden | 8 Stunden |
| Loki und Prometheus | Kein garantiertes RPO; kontrollierter Neuaufbau zulaessig | 8 Stunden |

Kann ein Ziel nicht wirtschaftlich erreicht werden, muss die Abweichung mit
konkretem Datenverlustfenster, Ersatzverfahren und verantwortlicher Freigabe
dokumentiert werden.

## 7. Zielarchitektur

### 7.1 Grundprinzip 3-2-1-1-0

Das Zielbild folgt erweitert der 3-2-1-Regel:

- mindestens drei Kopien einschliesslich Produktionsdaten;
- mindestens zwei technisch unabhaengige Speichermedien;
- mindestens eine Off-site-Kopie;
- mindestens eine fuer eine definierte Zeit immutable oder nur append-only
  beschreibbare Kopie;
- null ungepruefte Backupfehler nach den vorgesehenen Integritaetskontrollen.

Empfohlene Ebenen:

1. Primaerdaten auf dem ePiber-Host und in Google Sheets.
2. Verschluesseltes lokales Backup auf separatem Datentraeger oder NAS fuer
   schnelle Wiederherstellung.
3. Clientseitig verschluesseltes Off-site-Repository bei einem unabhaengigen
   Storageanbieter.

Ein lokales Backupverzeichnis auf demselben Dateisystem erfuellt Ebene 2 nicht.

### 7.2 Backupsoftware

Als primaeres dateibasiertes Backupwerkzeug wird `restic` empfohlen. Gruende:

- clientseitige authentifizierte Verschluesselung;
- Deduplizierung und inkrementelle Snapshots;
- integrierte Pruefsummen und Repositorychecks;
- Unterstuetzung lokaler, SFTP-, REST- und S3-kompatibler Ziele;
- klare Snapshot-, Tag- und Retentionsemantik;
- einfache systemd-Automatisierung.

Der normale Hostzugang soll nur neue Daten hinzufuegen koennen. Prune- und
Loeschberechtigungen gehoeren zu einer getrennten Wartungsidentitaet, die nicht
dauerhaft auf dem Anwendungsserver liegt. Wenn der Storageanbieter Object Lock
verwendet, muessen dessen Fristen mit Restic-Retention und Pruneverfahren
praktisch getestet werden.

### 7.3 Zwei Arten von Sicherungspunkten

#### Haeufiges Hot-Backup

- `state.sqlite`, `scorelog.sqlite` und `audit.sqlite` alle 15 Minuten mit einer
  unterstuetzten SQLite-Onlinebackup-Funktion sichern;
- Google Spreadsheet waehrend Veranstaltungen stuendlich, sonst alle vier
  Stunden als vollstaendige native Kopie sichern;
- zusaetzlichen unabhaengigen Sheets-API-Export erzeugen;
- Sicherungen sofort lokal pruefen und Off-site uebertragen;
- jede Quelle als einzeln konsistent, den Gesamtsatz aber als nicht global
  transaktional kennzeichnen.

Hot-Backups minimieren das Datenverlustfenster. Bei einem Restore muss der
Betreiber anhand Audit, Operationen und Metadata-Intents pruefen, ob eine
Nachklaerung zwischen Sheet und SQLite erforderlich ist.

#### Anwendungskonsistenter Sicherungspunkt

- einmal pro Nacht;
- unmittelbar vor jedem Rollout, jeder Datenmigration und jeder manuellen
  SQLite-Korrektur;
- nach besonders relevanten Veranstaltungen optional zusaetzlich als markierter
  akzeptierter Stand.

Dieser Ablauf wird je Instanz nacheinander ausgefuehrt. Live und PAJ werden nicht
ohne zwingenden Grund gleichzeitig angehalten.

## 8. Anwendungskonsistenter Sicherungsablauf

### 8.1 Vorbedingungen

- eindeutiges Backup-Set mit UTC-ID reservieren;
- exklusiven Prozesslock gegen parallele Backup- und Restorelaeufe erwerben;
- ausreichend freien Platz lokal und Off-site pruefen;
- Erreichbarkeit und Schreibberechtigung der Backupziele pruefen;
- aktuellen Git-Commit, Paketversion und installierte Unitzuordnung erfassen;
- `/live`, `/ready`, `/health` und bei berechtigtem Zugriff den relevanten
  Adminstatus pruefen;
- `pendingMetadataIntents` muss fuer einen regulaeren Sicherungspunkt null sein;
- direkte Sheet-Editoren und andere API-Clients muessen fuer das Sicherungsfenster
  Writes unterlassen;
- laufende Personennormalisierungen und Mitgliederabgleiche muessen abgeschlossen
  sein; es darf kein paralleler Write auf `Personen` mehr aktiv oder eingeplant sein;
- bestehende Sicherungen duerfen nicht ueberschrieben werden.

### 8.2 Drain und Snapshot

1. Betroffene Benutzer ueber das kurze Wartungsfenster informieren.
2. Dienst mit `systemctl stop epiber-<system>` kontrolliert stoppen.
3. Erfolgreichen SIGTERM-Abschluss innerhalb des 90-/95-Sekunden-Vertrags
   bestaetigen. Timeout, Signalabbruch oder Fehlerexit machen den Lauf ungueltig.
4. Sicherstellen, dass kein anderer Prozess das Spreadsheet schreibt.
5. Vollstaendige native Spreadsheet-Kopie erstellen.
6. Sheets-API-Export einschliesslich Developer Metadata erstellen.
7. Jede der drei SQLite-Datenbanken ueber SQLite-Onlinebackup in eine eigene
   normalisierte Sicherungsdatei kopieren. Bei einer Rohkopie muessen Hauptdatei,
   `-wal` und `-shm` ausschliesslich bei gestopptem Dienst gemeinsam behandelt
   werden.
8. `.env`, installierte Konfigurationsdateien und Geheimnisse getrennt und
   verschluesselt erfassen.
9. Manifest und Integritaetsnachweise erzeugen.
10. Den Backenddienst starten und Healthchecks ausfuehren.
11. Den validierten Satz zuerst auf das separate lokale Medium und danach
    Off-site uebertragen.
12. Erst nach bestaetigter Off-site-Replikation temporaere Klartext-Stagingdaten
    sicher entfernen.

### 8.3 Fehlerbehandlung

- Bei fehlgeschlagenem Shutdown darf der Satz nicht als konsistent markiert
  werden.
- Bei fehlgeschlagener Sheet-Kopie werden die SQLite-Dateien nicht als
  vollstaendiger Gesamtsatz freigegeben.
- Bei fehlgeschlagener SQLite-Integritaetspruefung bleibt die Quellinstanz
  unveraendert; der Fehler wird eskaliert und ein weiterer Satz darf den Fehler
  nicht verdecken.
- Bei fehlgeschlagenem Neustart wird der vorherige Iststand nicht geloescht. Der
  Dienst wird anhand des Rollback- und Recovery-Runbooks untersucht.
- Ein lokal erfolgreiches, aber nicht Off-site repliziertes Backup gilt nur als
  degradiert und loest eine kritische Meldung aus.

## 9. Google-Sheets-Sicherung

### 9.1 Native vollstaendige Kopie

Die schnelle Primaerwiederherstellung verwendet eine vollstaendige Drive-Kopie
des gesamten Spreadsheets, nicht einzelne Tabs. Anforderungen:

- Kopie durch eine dedizierte Backupidentitaet;
- Quell-Spreadsheet fuer die Backupidentitaet lesbar;
- Backupordner oder Shared Drive fuer die Backupidentitaet beschreibbar;
- Anwendungs-Service-Account darf Backupkopien weder aendern noch loeschen;
- Backup-ID, Quell-ID, Name, Erstellungszeit und verantwortliche Identitaet im
  Manifest;
- Kopie gegen versehentliche Bearbeitung geschuetzt;
- Erhaltung von Formeln, Formaten, Validierungen, benannten Bereichen und
  Developer Metadata praktisch verifiziert;
- Wiederherstellung immer zunaechst als neue Datei, nicht als unkontrolliertes
  Ueberschreiben der Quelle.

### 9.2 Unabhaengiger API-Export

Eine native Google-Kopie ist weiterhin vom Google-Konto und dessen
Berechtigungsmodell abhaengig. Deshalb wird parallel ein exportierbares Paket
erstellt und verschluesselt Off-site gesichert. Es enthaelt mindestens:

- Spreadsheet-Eigenschaften und Sheetliste;
- Zellwerte und Formeln aller relevanten Bereiche;
- Zeilen- und Spaltenstruktur;
- Developer Metadata einschliesslich `epiberRecord`;
- Datenvalidierungen und benannte Bereiche, soweit die API sie liefert;
- Drive-Dateimetadaten und eine kontrollierte Berechtigungsbeschreibung;
- je Tab einen lesbaren Export fuer manuelle Notfallanalyse;
- ein JSON-Manifest mit Quell-ID, Exportzeit und API-Version;
- kryptografische Pruefsummen aller Exportdateien.

CSV oder XLSX duerfen zusaetzlich enthalten sein, gelten allein aber nicht als
vollstaendiges ePiber-Backup. Zum Konzept gehoert ein getestetes Werkzeug, das
aus dem API-Paket ein neues Spreadsheet mit den benoetigten Strukturen und
Developer Metadata erzeugt.

### 9.3 Fachliche Verifikation

Mindestens folgende Punkte werden nach einer Testwiederherstellung geprueft:

- alle acht produktiv gepollten Tabs vorhanden;
- alle Pflichtspalten vorhanden;
- eindeutige IDs und kanonisch eindeutige belegte Personen-Logins; mehrere leere
  Logins bleiben fuer Personen ohne Zugang zulaessig;
- optionale Kontakt-E-Mails duerfen leer, ungueltig oder mehrfach belegt sein und
  werden weder als Login noch als fachlicher Eindeutigkeitskonflikt bewertet;
- `epiberRecord` je Wert hoechstens einer korrekten Zeile zugeordnet;
- keine Metadata auf falschem Tab, falscher ID oder leerer Zeile;
- mindestens ein aktiver Admin vorhanden;
- Service-Account besitzt nur die vorgesehenen Rechte;
- Testreads und kontrollierte PAJ-Testwrites funktionieren;
- Login und Passwort-Erstvergabe funktionieren ueber `Personen.Login`, nicht ueber
  die optionale Kontakt-E-Mail;
- der lokale PAJ-Mitgliederabgleich erkennt CD-ID-, Identitaets-, Fingerprint- und
  Login-Konflikte, zeigt die exakten ausgewaehlten Aktionen in der Vorschau und
  behandelt Familien-E-Mail-Dubletten ohne kuenstlichen Konflikt;
- Create, Update, Deaktivierung und bestaetigte Zuordnung laufen seriell; ein
  kontrollierter Fehler nach dem ersten Erfolg weist den Teilerfolg aus, behaelt
  offene Aktionen und fuehrt keinen automatischen Retry aus;
- `pendingMetadataIntents` nach dem Wiederanlauf plausibel beziehungsweise null.

## 10. SQLite-Sicherung

### 10.1 Zu sichernde Dateien

Je aktiver Instanz gehoeren zum fachlichen Satz:

- `state.sqlite`;
- `scorelog.sqlite`;
- `audit.sqlite`.

Die drei Datenbanken bleiben als getrennte Dateien erhalten. Sie werden weder in
eine gemeinsame Datenbank zusammengefuehrt noch durch Journalspiegel ersetzt.

### 10.2 Konsistenzverfahren

Bei laufendem Dienst wird nur ein unterstuetztes SQLite-Onlinebackup verwendet.
Ein einfaches Kopieren der Hauptdatei im WAL-Modus ist unzulaessig.

Bei gestopptem Dienst sind zwei Verfahren zulaessig:

- bevorzugt eine SQLite-Onlinebackup-Ausgabe in eine normalisierte Einzeldatei;
- alternativ eine konsistente Rohkopie aus Hauptdatei, `-wal` und `-shm` als
  untrennbarem Satz.

Eine einzelne WAL- oder SHM-Datei wird niemals separat gesichert, geloescht oder
wiederhergestellt.

### 10.3 Integritaetspruefung

Auf den Sicherungskopien, nicht auf den einzigen Produktionsdateien, werden
mindestens ausgefuehrt:

- `PRAGMA integrity_check`;
- `PRAGMA foreign_key_check`;
- erfolgreiche Oeffnung mit der freigegebenen SQLite-/Node-Version;
- Plausibilitaet der erwarteten Tabellen;
- letzte Court-Folgenummern im ScoreLog;
- Audit-Ergebnisverteilung und neuester Zeitstempel ohne Ausgabe von PII;
- Anzahl pending Metadata-Intents im State;
- Dateigroesse und Aenderung gegenueber dem vorherigen Lauf.

Ein Ergebnis ungleich `ok`, unerwartet fehlende Tabellen, deutlich fallende
Dateigroesse oder ruecklaeufige Sequenzen stoppen die Freigabe des Satzes.

### 10.4 Restorebedingte Sicherheitsbereinigung

Ein Restore von `state.sqlite` darf alte Autorisierungszustaende nicht blind
reaktivieren. Das Restorewerkzeug muss einen kontrollierten Modus bereitstellen,
der standardmaessig:

- alle Sessions entfernt;
- alle Passwort-Resetnachweise entfernt oder invalidiert;
- Loginlimits kontrolliert zuruecksetzt;
- Monitorgeraete fuer Neu-Provisionierung markiert oder deren Tokens rotiert;
- temporaere Frontend-Logging-Ziele prueft und abgelaufene entfernt;
- offene Operationen und Metadata-Intents nicht pauschal loescht, sondern fuer
  manuelle Klaerung meldet.

Nach einem Sicherheitsvorfall ist die Bereinigung zwingend. Nach einem rein
technischen Defekt darf nur eine dokumentierte Vier-Augen-Entscheidung davon
abweichen.

## 11. Konfiguration und Geheimnisse

### 11.1 Konfiguration

Zu jedem konsistenten Satz gehoert ein Manifest des installierten Zustands:

- aktive Caddydatei und deren Pruefsumme;
- aktive ePiber- und Observability-Units;
- relevante Environment-Zuordnungen ohne ausgegebene Werte;
- installierte Paketversionen;
- Benutzer, Gruppen und relevante Dateirechte;
- Firewall- und Listenerzustand;
- Git-Commit, Paketversion und Lockfile-Hash;
- Zielpfade der StateDirectories und Credentialquellen.

Versionierte Konfiguration wird primaer aus Git wiederhergestellt. Lokale
Abweichungen muessen entweder versioniert oder als ausdruecklich genehmigte
Hostkonfiguration dokumentiert sein.

### 11.2 Geheimnisse

Zu schuetzende Geheimnisse umfassen mindestens:

- Service-Account-JSON-Schluessel;
- `.env`-Werte;
- Grafana Break-glass-Passwort und Secret-Key;
- Backup-Repository-Passwort beziehungsweise Schluessel;
- Storagezugangsdaten.

Regeln:

- niemals in Git, Changelogs, Manifesten, Journals oder Tickets ausgeben;
- nur in root-only Stagingverzeichnissen mit `UMask=0077` verarbeiten;
- vor Off-site-Uebertragung clientseitig verschluesseln;
- Backupschluessel getrennt vom Backupziel und zusaetzlich offline hinterlegen;
- Zugriff auf Wiederherstellungsschluessel mindestens im Vier-Augen-Prinzip
  organisatorisch absichern;
- Service-Account-Schluessel nach Hostkompromittierung widerrufen und neu
  ausstellen, nicht aus einem alten Backup weiterverwenden;
- unkontrollierte Dateien wie `.env.bak` inventarisieren und entweder in das
  Verfahren ueberfuehren oder nach bestaetigter Sicherung sicher entfernen.

## 12. Backupmanifest

Jeder Sicherungssatz erhaelt ein maschinenlesbares Manifest und eine kurze
menschenlesbare Zusammenfassung. Mindestfelder:

- eindeutige Backup-Set-ID;
- Start- und Endzeit in UTC;
- Instanz und Backupart `hot`, `consistent`, `pre-rollout` oder `accepted`;
- Anwendungsversion und Git-Commit;
- Quell-Spreadsheet-ID und native Backup-ID;
- API-Exportformat und Exportwerkzeugversion;
- Shutdown- und Drainstatus;
- Liste aller erwarteten Assets;
- Dateigroessen und SHA-256-Pruefsummen;
- SQLite-Schema-/User-Versionen;
- Ergebnis von Integrity- und Foreign-Key-Checks;
- nicht personenbezogene Tabellen-, Sequenz- und Metadata-Zaehler;
- Restic-Snapshot-IDs fuer lokales und Off-site-Ziel;
- Retentionklasse und vorgesehenes Ablaufdatum;
- Ergebnis der Off-site-Replikation;
- bekannte Abweichungen und Freigabestatus.

Das Manifest enthaelt keine Cookies, Tokens, Passwortwerte, privaten Schluessel,
E-Mail-Adressen, IP-Adressen oder Auditereignisinhalte. Pruefsummen werden gegen
nachtraegliche Manipulation geschuetzt, beispielsweise durch eine Signatur oder
Speicherung im immutable Ziel.

## 13. Retention und Loeschung

### 13.1 Vorgeschlagene Generationen

| Generation | Aufbewahrung |
|---|---:|
| 15-Minuten-SQLite-Sicherungen | 48 Stunden |
| Stuendliche beziehungsweise vierstuendliche Wiederherstellungspunkte | 7 Tage |
| Taegliche konsistente Sicherungen | 35 Tage |
| Woechentliche Sicherungen | 13 Wochen |
| Monatliche Sicherungen | 12 Monate |
| Pre-Rollout-Sicherungen | 180 Tage oder bis zwei Folgereleases erfolgreich abgenommen sind |
| Markierte akzeptierte Veranstaltungsstaende | Nach gesonderter fachlicher Freigabe |
| Jahresarchive | Nur bei dokumentierter fachlicher oder rechtlicher Notwendigkeit |

Das Off-site-Ziel soll Sicherungen mindestens 30 Tage gegen Aenderung oder
Loeschung schuetzen. Retention und Storage-Lifecycle duerfen einander nicht
widersprechen und muessen praktisch mit Restore und Prune getestet werden.

### 13.2 Datenschutz

`audit.sqlite` enthaelt Namen sowie bei Loginversuchen vollstaendige normalisierte
gueltige Logins und Quell-IPs. Kontakt-E-Mail ist nicht Teil neuer Login-Audits;
historische oder andere Auditfelder koennen dennoch personenbezogene Kontaktdaten
enthalten. Backups vervielfachen diese Daten. Vor Aktivierung der langfristigen
Retention sind daher festzulegen:

- fachlicher und rechtlicher Aufbewahrungszweck;
- maximale Audit-Aufbewahrung;
- Berechtigte fuer Restore und Auswertung;
- Verfahren fuer angeordnete Loeschung oder Anonymisierung;
- Umgang mit bereits immutable gespeicherten Sicherungen;
- Nachbehandlung eines Restores, damit zwischenzeitliche Loeschungen erneut
  angewendet werden.

Immutable Backups werden nicht nachtraeglich manipuliert. Personenbezogene Daten
laufen ueber kurze, verbindliche Retention aus. Falls eine Wiederherstellung aus
einem aelteren Satz erfolgt, muss ein geschuetztes Loesch- beziehungsweise
Anonymisierungsregister die nach dem Backup ausgefuehrten Massnahmen erneut
anwenden koennen, ohne die geloeschten Klarwerte selbst dauerhaft zu speichern.

## 14. Monitoring und Alarmierung

### 14.1 Erforderliche Metriken

- Zeitpunkt des letzten erfolgreichen Hot-Backups je Instanz;
- Zeitpunkt des letzten konsistenten Backups je Instanz;
- Alter des letzten Off-site replizierten Satzes;
- letzter erfolgreicher SQLite-Integritaetscheck;
- letzter erfolgreicher Sheets-Export und native Backup-ID vorhanden;
- letzter erfolgreicher Restoretest;
- Backupdauer und uebertragene Datenmenge;
- Anzahl erwarteter und tatsaechlich gesicherter Assets;
- lokaler und entfernter freier Speicher beziehungsweise Quota;
- Restic-Repositorycheck und Pruneergebnis;
- Anzahl aufeinanderfolgender Fehler.

### 14.2 Alarmgrenzen

Mindestens kritisch sind:

- kein SQLite-Hot-Backup innerhalb von 30 Minuten;
- kein Sheet-Wiederherstellungspunkt innerhalb des freigegebenen RPO;
- kein konsistenter Gesamtsatz innerhalb von 30 Stunden;
- Off-site-Replikation laenger als zwei geplante Laeufe fehlgeschlagen;
- Integritaets- oder Foreign-Key-Check fehlgeschlagen;
- erwartetes Asset fehlt;
- Repositorycheck fehlgeschlagen;
- Restoretest ueberfaellig;
- lokaler oder entfernter Speicher unter definierter Sicherheitsreserve.

Da Grafana derzeit keine aktive Benachrichtigung versendet, muss Backupmonitoring
einen unabhaengigen Alarmweg besitzen. Zulaessig ist beispielsweise ein separater
Healthcheck-Empfaenger oder ein anderer ausdruecklich betriebener Kanal. Der
Alarmweg darf keine Secrets oder personenbezogenen Backupinhalte uebertragen.

## 15. Restore-Runbooks

### 15.1 Allgemeine Regeln

1. Ursache, betroffene Systeme und letzten sicheren Zeitpunkt bestimmen.
2. Entscheiden, ob Code-only-Rollback oder Datenrestore erforderlich ist.
3. Vor jedem Ueberschreiben den aktuellen Fehlerstand forensisch sichern.
4. Wiederherstellung zuerst in isolierter Umgebung oder auf PAJ pruefen.
5. Nur einen zusammengehoerigen, integral geprueften Sicherungssatz verwenden.
6. Keine einzelne WAL-Datei und keinen einzelnen Sheet-Tab isoliert restaurieren.
7. Geheimnisse nach Kompromittierung neu ausstellen.
8. Restorezeit, Datenverlustfenster, Entscheidungen und Pruefer dokumentieren.
9. Live-Restore nur mit Vier-Augen-Freigabe.
10. Nach erfolgreichem Betrieb den Restore als Audit- und Betriebsereignis
    dokumentieren, ohne personenbezogene Daten in das Freigabeprotokoll zu kopieren.

### 15.2 SQLite-Korruption

1. Betroffenen Dienst stoppen und erfolgreichen Drain pruefen.
2. Beschadigte Hauptdateien und Sidecars als forensischen Satz sichern.
3. Letzten geeigneten Sicherungssatz anhand Manifest, Integritaet und Zeitpunkt
   auswaehlen.
4. Alle fachlich zusammengehoerigen Datenbanken aus demselben Satz bereitstellen.
5. Restorekopien erneut mit Integrity- und Foreign-Key-Check pruefen.
6. Sicherheitsbereinigung fuer Sessions, Resetnachweise und Monitorzugriffe
   ausfuehren.
7. Operationen und Metadata-Intents auf unklare Sheetwrites pruefen.
8. Dienst starten und `/version`, `/live`, `/ready` und `/health` pruefen.
9. Rollen/Login, kontrollierten Auditwrite, ScoreLog-Sequenz und Court-/Monitor-
   State testen.
10. Datenverlustfenster und nicht rekonstruierbare Ereignisse dokumentieren.

### 15.3 Logische Google-Sheets-Korruption

1. Backend und weitere schreibende Clients stoppen.
2. Beschaedigten aktuellen Spreadsheetstand vollstaendig forensisch kopieren.
3. Native Backupkopie oder API-Wiederaufbau als neues Spreadsheet bereitstellen.
4. Tabs, Pflichtspalten, IDs, belegte eindeutige Logins, optionale auch doppelte
   Kontakt-E-Mails, Querverweise und Developer Metadata pruefen.
5. Service-Account-Freigaben mit minimalen Rechten herstellen.
6. Unknown-Writes, Operationsresultate und Metadata-Intents gegen Audit und
   wiederhergestellte Sheetzeilen abgleichen.
7. `SHEET_ID` kontrolliert auf die neue Datei umstellen; Original nicht
   unkontrolliert ueberschreiben.
8. Backend starten und vollstaendige Readiness- und PAJ-Fachpruefung ausfuehren;
   dazu gehoeren Login-basierte Anmeldung/Erstvergabe sowie der lokale
   Admin-Mitgliederabgleich mit Vorschau, Konflikt- und Teilerfolgspfad.
9. Nur bei nachgewiesener Dateninkompatibilitaet SQLite aus demselben
   Sicherungszeitpunkt wiederherstellen.
10. Alte Datei bis zum Abschluss der Untersuchung unveraendert aufbewahren.

### 15.4 Fehlerhafter Release

- Wenn Daten und Schema kompatibel sind, nur Code und versionierte Vorlagen auf
  den dokumentierten vorherigen Commit zuruecksetzen.
- Daten nicht allein deshalb zurueckspielen, weil Code zurueckgerollt wird.
- Bei inkompatiblem Schema oder State den vor dem Rollout erstellten konsistenten
  Satz verwenden.
- Rollback zuerst auf PAJ, danach Live durchfuehren.
- Paketversion, Lockfile, Caddy, systemd, Health, Rollen, WSS, Monitor und
  Kerndaten pruefen.

### 15.5 Vollstaendiger Hostverlust

1. Sauberen Ersatzhost aus vertrauenswuerdiger Basis bereitstellen.
2. Betriebssystem aktualisieren und benoetigte Pakete installieren.
3. Benutzer, Gruppen, Rechte, Firewall und Netzwerkgrenzen reproduzieren.
4. Freigegebenen Git-Commit und exaktes Lockfile installieren.
5. Caddy-, systemd-, journald- und Observability-Konfiguration installieren und
   validieren.
6. Service-Account- und andere Hostschluessel neu ausstellen, falls der alte Host
   nicht nachweislich sicher ausgefallen ist.
7. Verschluesselte Konfiguration und zusammengehoerige SQLite-Saetze
   wiederherstellen.
8. Google-Spreadsheets anbinden oder aus geschuetzten Kopien wiederherstellen.
9. Sessions, Resetnachweise und Monitoranmeldungen invalidieren beziehungsweise
   neu provisionieren.
10. PAJ vollstaendig abnehmen.
11. Live nach erfolgreicher PAJ-Abnahme starten und eng beobachten.
12. DNS, Zertifikate, externe Ports, WSS und Observability pruefen.
13. Alten Host, alte Credentials und alte Storagezugriffe sperren.

### 15.6 Ransomware oder Root-Kompromittierung

- keine In-place-Reparatur als vertrauenswuerdigen Produktionsweg verwenden;
- neuen sauberen Host aufbauen;
- immutable Off-site-Sicherung vor dem vermuteten Angriffszeitpunkt verwenden;
- alle Service-Account-, Backup-, SSH- und sonstigen Hostcredentials rotieren;
- alle Benutzersessions, Resetnachweise und Monitorcredentials invalidieren;
- Backuprepository auf Manipulation und unerwartete Loeschversuche untersuchen;
- wiederhergestellte Daten vor Livefreigabe auf Schadartefakte und unplausible
  Aenderungen pruefen;
- Vorfall und Datenverlustfenster getrennt vom normalen Rollout behandeln.

## 16. Restoretests

| Intervall | Mindestpruefung |
|---|---|
| Bei jedem Backup | Manifest vollstaendig, Pruefsummen, SQLite-Integritaet und erwartete Assets |
| Taeglich | Backupalter, Off-site-Replikation, Groessenentwicklung und Quota |
| Woechentlich | Erweiterter Repositorycheck und stichprobenartige Packdatenpruefung |
| Monatlich | Automatisierter Restore aller SQLite-Dateien in isoliertes temporaeres Verzeichnis |
| Vierteljaehrlich | Vollstaendiger PAJ-Restore mit nativer Sheet-Kopie, Developer Metadata und Anwendungstests |
| Halbjaehrlich | Host-DR-Test auf einer frischen VM oder einem getrennten Ersatzsystem |
| Jaehrlich | Zeitgemessene Notfalluebung mit Betreiber, Stellvertretung und dokumentierter Nachbesprechung |

Ein Restoretest gilt nur als erfolgreich, wenn:

- Daten technisch integral sind;
- das Backend mit der Zielversion startet;
- `/live`, `/ready` und `/health` erfolgreich sind;
- Tabellenloads und Rollen funktionieren;
- belegte Personen-Logins eindeutig sind, doppelte optionale Kontakt-E-Mails den
  Tabellenload nicht blockieren und Login/Erstvergabe `Personen.Login` verwenden;
- Developer Metadata korrekt ist;
- Audit- und ScoreLog-Schreibpfade funktionieren;
- der Audit-Backupinhalt vollstaendige gueltige Loginversuche und Quell-IPs
  enthaelt, waehrend der Journalspiegel beide nur maskiert ausgibt;
- der PAJ-Mitgliederabgleich CSV lokal verarbeitet, Vorschau und einzelne
  Aktionen korrekt abbildet, Konflikte vor Writes stoppt und Teilerfolg ohne
  parallele Personenwrites oder automatischen Retry behandelt;
- Sicherheitsbereinigung nachgewiesen ist;
- der Test innerhalb des RTO abgeschlossen wurde;
- Testdaten und temporaere Restoreumgebung anschliessend kontrolliert entfernt
  oder als geschuetzter Nachweis weitergefuehrt werden.

## 17. Rollen und Verantwortlichkeiten

| Rolle | Verantwortung |
|---|---|
| Systembetreiber | Backupbetrieb, Timer, Kapazitaet, Stoerungsbehebung und technische Restoreausfuehrung |
| Fachverantwortlicher | RPO/RTO, fachliche Datenpruefung, Retention und Freigabe des wiederhergestellten Standes |
| Zweiter Pruefer | Vier-Augen-Kontrolle bei Live-Restore, Credentialzuordnung und Datenverlustentscheidung |
| Backupadministrator | Storage, Append-only-/Immutable-Regeln, Prune und Repositorywartung |
| Schluesselverwahrer | Getrennte Hinterlegung und kontrollierte Ausgabe der Restore-Schluessel |
| Datenschutzverantwortlicher | Aufbewahrung, Loeschung, Audit-PII und Restore-Nachbehandlung |

Mindestens zwei benannte Personen muessen den vollstaendigen Restoreweg kennen.
Schluessel und Wissen duerfen keinen einzelnen personellen Ausfallpunkt bilden.

## 18. Umsetzungsplan

### Phase 1: Entscheidungen und Inventar

- RPO und RTO fachlich freigeben;
- Audit- und Backupretention datenschutzrechtlich festlegen;
- Datenmengen und taegliche Aenderungsraten messen;
- lokale und Off-site-Kapazitaet dimensionieren;
- Verantwortliche und Eskalationsweg benennen;
- PK ausdruecklich ausserhalb des aktiven Umfangs halten, bis seine Aktivierung
  separat freigegeben ist.

### Phase 2: Storage und Identitaeten

- separates lokales Backupmedium oder NAS bereitstellen;
- unabhaengiges Off-site-Ziel einrichten;
- Restic installieren und Repositories initialisieren;
- dedizierte Backup- und Wartungsidentitaeten einrichten;
- Append-only-/Immutable-Regeln und Schluesselhinterlegung testen.

### Phase 3: Sicherungswerkzeuge

- SQLite-Onlinebackup fuer alle drei Dateien implementieren;
- native Drive-Kopie automatisieren;
- vollstaendigen Sheets-API-Export samt Developer Metadata implementieren;
- Manifest, Pruefsummen und Integritaetspruefungen erzeugen;
- verschluesseltes Konfigurations- und Secretbackup implementieren;
- exklusiven Lock, Stagingbereinigung und eindeutige Exitcodes vorsehen.

### Phase 4: systemd-Automatisierung

- root-only Oneshot-Services fuer Hot- und konsistente Backups erstellen;
- systemd-Timer mit zufaelliger Startverzoegerung und Persistenz definieren;
- Netzwerk- und Storage-Abhaengigkeiten begrenzen;
- Laufzeit, Ressourcen und Dateirechte absichern;
- parallele Laeufe verhindern;
- manuelle Pre-Rollout-Ausfuehrung dokumentieren.

### Phase 5: Monitoring

- Backupmetriken ohne Geheimnisse bereitstellen;
- Grafana-Dashboard und Alerts ergaenzen;
- unabhaengigen aktiven Benachrichtigungsweg einrichten;
- Alarmierung durch absichtlich fehlgeschlagenen PAJ-Lauf testen.

### Phase 6: Restorewerkzeuge

- SQLite-Restore mit Sicherheitsbereinigung implementieren;
- Sheet-Restore als neue Datei implementieren;
- Developer-Metadata-Rekonstruktion und -Pruefung automatisieren;
- Host-Build- und Credential-Rotationsrunbook vervollstaendigen;
- forensische Sicherung des Fehlerstands vor Ueberschreiben erzwingen.

### Phase 7: Abnahme auf PAJ

- Hot-Backup und konsistenten Satz erzeugen;
- lokale und Off-site-Kopie pruefen;
- PAJ aus leerer Restoreumgebung wiederherstellen;
- fachliche und technische Checkliste vollstaendig ausfuehren;
- RPO, RTO und Restdauer messen;
- Fehler und offene Restarbeit dokumentieren.

### Phase 8: Livefreigabe

- identischen bestaetigten Werkzeugstand installieren;
- frischen Pre-Rollout-Satz erzeugen;
- Live-Timer aktivieren und erste Off-site-Replikation bestaetigen;
- Backupalter und Alarmierung waehrend des Nachbeobachtungsfensters pruefen;
- halbjaehrlichen DR-Termin verbindlich einplanen.

## 19. Abnahmekriterien

Das Backupkonzept ist erst als produktiv umgesetzt freigegeben, wenn:

- mindestens drei Kopien auf mindestens zwei unabhaengigen Medien existieren;
- mindestens eine Kopie Off-site liegt;
- mindestens eine Kopie fuer die freigegebene Frist immutable oder append-only
  geschuetzt ist;
- Hot- und konsistente Backups automatisch laufen;
- RPO und RTO praktisch nachgewiesen sind;
- Google Developer Metadata nach Restore vollstaendig und eindeutig ist;
- alle SQLite-Sicherungen Integritaets- und Foreign-Key-Pruefungen bestehen;
- ein kompletter PAJ-Restore erfolgreich war;
- ein Host-DR-Test erfolgreich war;
- Backupfehler aktiv und unabhaengig gemeldet werden;
- Restore keine alten Sessions, Resetnachweise oder widerrufenen Monitorzugriffe
  unkontrolliert reaktiviert;
- Schluesselverlust und Hostkompromittierung als Szenarien behandelt sind;
- Retention und Datenschutzfreigabe dokumentiert sind;
- Betreiber und Stellvertretung den Restore praktisch ausgefuehrt haben;
- kein Manifest, Journal oder Freigabeprotokoll Geheimnisse oder unzulaessige
  personenbezogene Inhalte enthaelt.

## 20. Offene Entscheidungen

Vor der technischen Umsetzung muessen mindestens folgende Punkte entschieden
werden:

1. Verbindliche RPO-/RTO-Werte fuer Veranstaltung und Normalbetrieb.
2. Lokales zweites Medium oder NAS.
3. Off-site-Anbieter, Region, Kostenrahmen und Immutable-Verfahren.
4. Verbindliche Retention fuer Auditdaten und deren Backups.
5. Aktiver Alarmierungsweg ausserhalb der derzeit manuellen Grafana-Kontrolle.
6. Verantwortliche Personen und Schluesselverwahrung.
7. Verfahren zur erneuten Anwendung angeordneter Loeschungen nach Restore.
8. Umgang mit bestehenden unkontrollierten Konfigurationskopien.
9. Ob Loki-/Prometheus-Daten fuer forensische Zwecke separat gesichert werden.
10. Termin und Zielumgebung fuer den ersten vollstaendigen PAJ-Restore.

Bis diese Entscheidungen und die Abnahmekriterien erfuellt sind, bleiben die
vorhandenen manuellen Rolloutbackups notwendige Mindestmassnahme, stellen aber
kein vollstaendiges Disaster-Recovery-Konzept dar.
