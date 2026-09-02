# E-Mail-Direktzustellung vom ePiber-Server

Stand: 31.08.2026
Status: Umsetzungsplanung; noch nicht implementiert, installiert oder freigegeben
Gegenstand: Automatischer Versand von ePiber-Systemmeldungen ohne externes
SMTP-Relay direkt an die MX-Server der Empfaenger

Diese Datei ist eine nicht-kanonische Arbeitsgrundlage unter `Project/2do/`.
Sie dokumentiert die getroffene Grundentscheidung, Voraussetzungen, Risiken,
Umsetzungsschritte und Abnahmekriterien. Die kanonische Software- und
Serverdokumentation wird erst bei der spaeter freigegebenen Umsetzung nach dem
Projektworkflow aktualisiert.


## 1. Verbindliche Grundentscheidung

ePiber soll E-Mails spaeter ohne externen SMTP-Relay-Dienst zustellen. Die
Anwendung uebergibt ausgehende Nachrichten an einen lokal gebundenen Mail
Transfer Agent auf demselben Server. Dieser stellt sie ueber TCP-Port 25 direkt
an die im DNS veroeffentlichten MX-Server der Empfaengerdomains zu.

Vorgesehener Weg:

```text
ePiber-Meldungs-Outbox
  -> lokaler Postfix
  -> DNS/MX-Aufloesung der Empfaengerdomain
  -> direkter SMTP-Versand an den Empfaengerserver
```

Ausdruecklich nicht vorgesehen sind:

- ein externer SMTP-Relay- oder Transaktionsmail-Dienst,
- die Automatisierung eines privaten Webmail- oder Mailkontos,
- ein offenes SMTP-Relay,
- oeffentliche Benutzeranmeldung an Postfix,
- ein vollstaendiger eigener Mailbox-, IMAP- oder Webmailbetrieb,
- eine unkontrollierte synchrone Sendefunktion innerhalb eines Fachrequests.

Der bestehende MX von `epiber.at` soll zunaechst unveraendert bleiben. Der neue
Server ist damit primaer ein ausgehender MTA. Eine spaetere eigene Annahme von
Ruecklaeufern wird getrennt und nur auf einer dafuer vorgesehenen Subdomain
aktiviert, falls der bestehende Mailanbieter keine geeignete Bounce-Adresse
bereitstellt.


## 2. Beobachteter Ausgangsstand

Die folgenden oeffentlichen DNS-Werte wurden am 31.08.2026 beobachtet und sind
vor jeder Umsetzung erneut zu pruefen:

| Eintrag | Beobachteter Wert | Bewertung |
|---|---|---|
| `A epiber.at` | `49.13.20.166` | aktuelle IPv4 der Webanwendung |
| `AAAA epiber.at` | `2a01:4f8:c010:903c::` | IPv6 vorhanden; Mailversand darueber noch ungeprueft |
| `MX epiber.at` | `10 www4.your-server.de` | eingehende Domain-Mail liegt derzeit beim bestehenden Anbieter |
| `TXT epiber.at` | `v=spf1 +a +mx ?all` | Webserver ist ueber `a` grundsaetzlich erfasst, Abschluss aber nur neutral |
| `_dmarc.epiber.at` | nicht vorhanden | DMARC muss eingefuehrt werden |
| PTR `49.13.20.166` | `static.166.20.13.49.clients.your-server.de` | fuer verlaesslichen Mailversand ungeeignet |
| `mail.epiber.at` | nicht vorhanden | eigener Mailhostname ist anzulegen |

DNS erlaubt keine vollstaendige Suche nach allen DKIM-Selektoren. Deshalb muss
vor der Umsetzung mit dem bestehenden Mailanbieter geklaert werden, welche
DKIM-, SPF- und DMARC-Eintraege er bereits verwendet und weiterhin benoetigt.

Im aktuellen Seitenbranch besteht bereits ein `EmailMessagingAdapter`, der
ausschliesslich `not_configured` liefert. Der bestehende Meldungsablauf ruft den
Adapter derzeit vor dem persistenten Speichern der Meldung auf und uebergibt nur
Nachrichten- und Empfaenger-ID. Dieser Dummyvertrag ist fuer echten Versand
nicht ausreichend und muss vor Aktivierung recovery-sicher umgebaut werden.


## 3. Externe Voraussetzungen und Go/No-Go-Pruefung

Vor Installation oder DNS-Aenderungen muessen alle folgenden Punkte positiv
bestaetigt sein:

1. Der Server besitzt dauerhaft dieselbe oeffentliche IPv4-Adresse.
2. Der Hoster erlaubt eigenen direkten SMTP-Versand laut Vertrag und
   Missbrauchsrichtlinie.
3. Ausgehendes TCP 25 kann vom Server zu fremden MX-Servern geoeffnet werden.
4. Der Hoster setzt fuer die IPv4 einen frei waehlbaren PTR/rDNS-Eintrag.
5. Die IPv4 steht nicht auf relevanten Blocklisten und hat keine bekannte
   negative Mailreputation.
6. Die Verantwortlichen besitzen Schreibzugriff auf die DNS-Zone `epiber.at`.
7. Eine funktionsfaehige Adresse fuer Antworten, DMARC-Berichte und unzustellbare
   Nachrichten ist vorhanden oder wird im Zuge der Umsetzung geschaffen.
8. Es ist geklaert, ob die vorhandene IPv6 ebenfalls korrekt fuer Mail
   eingerichtet wird. Bis dahin versendet Postfix ausschliesslich ueber IPv4.
9. Der erwartete Versandumfang und Spitzenversand sind festgelegt.
10. Fuer jede Meldungsart sind Rechtsgrundlage, Empfaengerkreis und erlaubter
    Nachrichteninhalt festgelegt.

Ein Scheitern bei Port 25, festem PTR oder Hosterfreigabe ist ein No-Go fuer
Direktzustellung. Das darf nicht durch inoffizielle Tunnel, fremde offene Relays
oder das Umgehen von Hosterbeschraenkungen kompensiert werden.


## 4. Zielarchitektur auf dem Server

### 4.1 Mail Transfer Agent

Vorgesehen ist Postfix als ausgehender MTA. Postfix uebernimmt:

- lokale Annahme von ePiber,
- DNS- und MX-Aufloesung,
- TLS-gesicherte Zustellung, soweit der Zielserver STARTTLS anbietet,
- Queueing und erneute Zustellversuche bei temporaeren Fehlern,
- Erzeugung nachvollziehbarer Queue-IDs,
- Behandlung permanenter SMTP-Ablehnungen,
- Begrenzung von Parallelitaet und Versandrate.

Die Anwendung darf Postfix nur lokal erreichen. Bevorzugt wird ein Unix-Socket;
alternativ ist ein ausschliesslich an Loopback gebundener SMTP-Port zulaessig.
Es wird kein oeffentlicher Submission-Port 587 oder SMTPS-Port 465 benoetigt.

Postfix muss so konfiguriert werden, dass ausschliesslich kontrollierte lokale
Absender zustellen duerfen. Ein Relay fuer externe Clients ist ausgeschlossen
und in der Abnahme explizit negativ zu testen.

### 4.2 DKIM-Signatur

Ein lokaler DKIM-Signer, beispielsweise Rspamd oder OpenDKIM, signiert jede
ausgehende ePiber-Nachricht. Der private Schluessel:

- liegt nur auf dem Server,
- wird niemals im Repository, Journal oder Changelog gespeichert,
- besitzt restriktive Dateirechte,
- ist nur fuer den Signaturdienst lesbar,
- wird nach einem dokumentierten Verfahren rotiert.

Ein datierter Selektor erleichtert die Rotation, beispielsweise:

```text
epiber2026._domainkey.epiber.at
```

Vor Auswahl des konkreten Signaturdienstes sind Paketverfuegbarkeit,
Wartungszustand und systemd-Hardening auf dem eingesetzten Arch Linux zu
pruefen. Es wird nur ein DKIM-Signer eingefuehrt.

### 4.3 Diensttrennung

Postfix und DKIM-Signer laufen unter eigenen unprivilegierten Dienstkonten. Die
ePiber-Service-User erhalten weder allgemeine Mailserverrechte noch Zugriff auf
DKIM-Schluessel oder Mailqueues. Die Anwendung darf nur kontrollierte
Nachrichten an den lokalen Einlieferungspunkt uebergeben.

Versionierte Postfix-, DKIM-, systemd- und Monitoringvorlagen werden spaeter
unter `Project/server-configs/` abgelegt. Installierte Konfigurationen und
Schluessel bleiben ausserhalb des Repositorys.


## 5. DNS-Zielzustand

### 5.1 Mailhostname und PTR

Vorgesehener Hostname:

```text
smtp.epiber.at
```

Erforderliche Vorwaerts- und Rueckwaertsaufloesung:

```text
smtp.epiber.at.  A    49.13.20.166
49.13.20.166     PTR  smtp.epiber.at.
```

Postfix verwendet denselben Namen fuer Hostidentitaet und `EHLO`. Nach Setzen
des PTR muss die Forward-confirmed-Reverse-DNS-Pruefung in beide Richtungen
erfolgreich sein.

Falls spaeter ueber IPv6 versendet wird, braucht auch die verwendete IPv6 einen
passenden PTR auf denselben oder einen eindeutig zugeordneten Mailhostname.
Solange das nicht vollstaendig eingerichtet und getestet ist, wird SMTP-Ausgang
auf IPv4 begrenzt.

### 5.2 SPF

Der heutige SPF-Eintrag darf nicht blind ersetzt werden, weil der bestehende MX
oder andere legitime Absender weiterhin autorisiert sein koennen. Der spaetere
Zielwert muss alle tatsaechlichen Absender enthalten und die Server-IP explizit
autorisieren, schematisch zum Beispiel:

```text
v=spf1 ip4:49.13.20.166 mx -all
```

`-all` wird erst gesetzt, nachdem alle bestehenden Versandwege ermittelt und
getestet wurden. Es darf genau einen SPF-Record fuer die Domain geben.

### 5.3 DKIM

Der oeffentliche DKIM-Schluessel wird unter dem gewaehlten Selektor als TXT
veroeffentlicht, schematisch:

```text
epiber2026._domainkey.epiber.at TXT "v=DKIM1; k=rsa; p=<PUBLIC_KEY>"
```

Der reale Schluessel wird nicht in dieser Planungsdatei dokumentiert. Vor
Aktivierung wird eine Testnachricht auf gueltige Signatur und Domain-Alignment
geprueft.

### 5.4 DMARC

DMARC beginnt in einer Beobachtungsphase, beispielsweise:

```text
_dmarc.epiber.at TXT "v=DMARC1; p=none; rua=mailto:dmarc@epiber.at"
```

Die Berichtadresse muss existieren und die eingehenden aggregierten Berichte
datenschutzgerecht verarbeiten. Erst nach stabiler SPF-/DKIM-Ausrichtung und
Auswertung der Berichte wird kontrolliert auf `quarantine` und gegebenenfalls
spaeter auf `reject` verschaerft.

### 5.5 Bestehender MX

Der MX von `epiber.at` wird fuer reinen ausgehenden Direktversand nicht
geaendert. Dadurch bleiben normale Antworten und bestehende Postfaecher beim
heutigen Anbieter. Eine MX-Aenderung ist ein eigenes Infrastrukturprojekt und
nicht Teil dieser Planung.


## 6. Absender-, Antwort- und Bounce-Konzept

Die konkreten Adressen sind vor Umsetzung festzulegen. Vorgesehene Struktur:

```text
From: ePiber <system@epiber.at>
Reply-To: <betreute Vereinsadresse>
Message-ID: <stabile eindeutige ID unter epiber.at>
Return-Path: <technische Bounce-Adresse>
```

`From` darf nicht frei durch Fachparameter oder Browserrequests gesetzt werden.
Anzeigename, Absenderdomain und Reply-To stammen aus serverseitiger
Konfiguration. Betreff und Inhalt werden aus kontrollierten Meldungstypen und
validierten Fachdaten erzeugt; Zeilenumbrueche in Headerfeldern sind verboten.

Fuer Ruecklaeufer bestehen zwei geordnete Varianten:

1. Bevorzugt fuer die erste Stufe: Eine betreute Bounce-Adresse beim bestehenden
   MX von `epiber.at` nimmt Unzustellbarkeitsmeldungen an. Diese werden zunaechst
   kontrolliert ausgewertet und spaeter bei Bedarf automatisiert verarbeitet.
2. Falls dort keine geeignete Empfangsadresse moeglich ist: Eine getrennte
   Bounce-Subdomain erhaelt einen eigenen MX auf den ePiber-Mailhost. Postfix
   nimmt dann auf dem oeffentlichen Port 25 ausschliesslich die dafuer
   vorgesehenen Ruecklaeufer an. Diese Erweiterung benoetigt zusaetzliche
   Firewall-, TLS-, Spam-, Speicher-, Parser- und Missbrauchsschutzpruefungen.

Die zweite Variante macht den Server teilweise zu einem eingehenden Mailserver
und wird nicht stillschweigend mit dem ausgehenden MTA aktiviert. Catch-all-
Postfaecher und frei nutzbare Weiterleitungen sind ausgeschlossen.


## 7. Integration in das ePiber-Meldungswesen

### 7.1 Persistieren vor externer Wirkung

Der aktuelle Dummyablauf darf nicht nur durch echten SMTP-Code ersetzt werden.
Vor dem ersten Versandversuch muessen Meldung und Email-Zustellauftrag atomar in
`messaging.sqlite` gespeichert sein. Erst ein separater Worker fuehrt die
externe Wirkung aus.

Zielablauf:

1. Fachoperation wird erfolgreich abgeschlossen.
2. Meldung und interne Inbox-Zustellung werden idempotent gespeichert.
3. Bei aktivem Kanal `Email` wird atomar ein Zustellauftrag `queued` angelegt.
4. Ein Worker beansprucht den Auftrag mit zeitlich begrenztem Lease.
5. Empfaengeradresse und kontrollierter Nachrichteninhalt werden serverseitig
   aufgeloest und validiert.
6. Der Worker uebergibt die Nachricht genau einmal pro Versuch an Postfix.
7. Postfix bestaetigt die lokale Queue-ID; der Status wird `submitted`.
8. Temporaere lokale Fehler fuehren zu begrenzten Wiederholungen mit Backoff.
9. Permanente Validierungs- oder Konfigurationsfehler werden `rejected`.
10. Bleibt der Ausgang nach einem Prozessabbruch unklar, wird er `unknown` und
    nicht blind als erfolgreich oder fehlgeschlagen behandelt.

Die bisherige Statusmenge `delivered`, `failed` und `not_configured` muss dafuer
fachlich erweitert oder durch einen getrennten Zustellversuchsstatus ergaenzt
werden. Eine erfolgreiche lokale Postfix-Annahme ist `submitted`, nicht
`delivered`. Endgueltige Zustellung ist nur nach der Antwort des fremden
MX-Servers beziehungsweise durch kontrollierte Bounce-Auswertung bewertbar.

### 7.2 Idempotenz und Crash-Recovery

Jede E-Mail verwendet eine stabile ePiber-Nachrichten-ID. Zusaetzlich werden je
Versuch mindestens gespeichert:

- Kanal,
- Zustellstatus,
- Versuchnummer,
- naechster Versuchzeitpunkt,
- Lease-Ablauf,
- kontrollierter Fehlercode,
- Postfix-Queue-ID nach erfolgreicher Einlieferung,
- Zeitpunkte fuer Start und Abschluss.

Ein Prozessabbruch zwischen Postfix-Annahme und SQLite-Update kann zu einem
unklaren Ausgang fuehren. Dieser Fall muss durch Queue-ID-Korrelation,
deterministische `Message-ID` und einen ausdruecklichen `unknown`-Pfad behandelt
werden. SMTP besitzt keine allgemeine empfaengerseitige Exactly-once-Garantie;
die Implementierung minimiert Dubletten, darf diese Grenze aber nicht als
garantierte Zustellung darstellen.

### 7.3 Empfaengeradresse

Die E-Mail-Adresse wird beim Versand serverseitig aus dem aktuellen
Personenbestand gelesen. Browser und Fachaufrufer uebergeben keine Zieladresse.
Leere oder ungueltige Kontaktadressen fuehren zu einer kontrollierten Ablehnung
des externen Kanals, waehrend die interne ePiber-Inbox erhalten bleibt.

Vor Aktivierung ist fachlich festzulegen, wie mit einer Adressaenderung zwischen
Meldungserzeugung und Versandversuch umgegangen wird. Empfohlen ist ein
kontrollierter Empfaenger-Snapshot im Zustellauftrag, damit spaetere Retries
nicht unbeabsichtigt an eine andere Person oder Adresse gehen. Dieser Snapshot
ist personenbezogen, wird verschluesselt beziehungsweise durch die bestehenden
Dateirechte geschuetzt und nicht in Logs projiziert.

### 7.4 Nachrichtenformat

Jede Nachricht enthaelt:

- eine UTF-8-Textversion,
- optional eine einfache HTML-Version mit identischem Inhalt,
- einen kontrollierten Betreff,
- die stabile `Message-ID`,
- `Date`, `From`, `To`, `Reply-To` und technische Trace-Header,
- keine extern geladenen Trackingpixel,
- keine personenbezogenen Daten in URL-Querystrings,
- keine unnoetigen Anhaenge.

HTML-Inhalte werden escaped und nicht aus frei uebernommenem HTML aufgebaut.
Links zeigen ausschliesslich auf die kanonische HTTPS-Origin und enthalten keine
Session- oder Authentifizierungstokens.


## 8. Zustellversuche und Postfix-Queue

Anwendungs-Outbox und Postfix-Queue haben getrennte Verantwortungen:

- Die ePiber-Outbox garantiert, dass ein beabsichtigter Versandauftrag nach
  Prozessneustart weiterbearbeitet werden kann.
- Die Postfix-Queue uebernimmt nach lokaler Annahme DNS-, SMTP- und
  Wiederholungslogik gegen den fremden MX-Server.

Nach erfolgreicher Postfix-Annahme darf ePiber nicht parallel selbst erneut an
denselben Empfaenger zustellen. Postfix-Retry und Anwendungs-Retry duerfen sich
nicht ueberlagern.

Festzulegen und zu testen sind:

- maximale Anzahl lokaler Einlieferungsversuche,
- Lease- und Backoff-Zeiten,
- maximale Postfix-Queue-Lebensdauer,
- maximale gleichzeitige Zustellungen,
- globale und empfaengerdomainbezogene Rate Limits,
- maximale Nachrichten- und Queue-Groesse,
- Verhalten bei DNS-Fehlern, Greylisting, `4xx`, `5xx` und TLS-Problemen,
- manueller Wiederanlauf und kontrolliertes Verwerfen eines Auftrags.


## 9. Sicherheit und Datenschutz

### 9.1 Geheimnisse und Dateirechte

- DKIM-Privatschluessel und lokale Mailkonfiguration mit geheimen Werten werden
  nicht versioniert.
- Schluesseldateien erhalten minimal notwendige Besitzer und Rechte.
- ePiber erhaelt keinen Lesezugriff auf DKIM-Privatschluessel.
- Mailqueue und Zustelldaten sind nur fuer die erforderlichen Dienste lesbar.
- Backups muessen die Schluesselbehandlung und Wiederherstellung ausdruecklich
  regeln.

### 9.2 Missbrauchsschutz

- Kein Open Relay und keine oeffentliche SMTP-Authentifizierung.
- Versand nur fuer serverseitig bekannte Meldungstypen.
- Globale, personenbezogene und meldungstypbezogene Limits.
- Keine frei waehlbaren Absender, Ziele, Betreffe oder Header.
- Schutz gegen Header-Injection und unkontrollierte Empfaengerlisten.
- Keine Weiterleitung fremder Roh-MIME-Nachrichten.
- Queue-Groessenlimit und Alarm bei auffaelligem Wachstum.
- Sofortiger administrativer Kill-Switch fuer externen E-Mail-Versand, ohne die
  interne Inbox abzuschalten.

### 9.3 Personenbezogene Daten

E-Mail-Adresse, Betreff, Nachrichtentext und Bounce-Inhalt sind personenbezogene
Daten. Es gelten Datenminimierung und begrenzte Aufbewahrung:

- keine Klartextadresse oder Nachrichtentexte in Journald, Loki oder Metriken,
- keine freien SMTP-Antworttexte in dauerhaften Logs,
- kontrollierte Fehlercodes statt fremder Freitexte,
- definierte Aufbewahrungsfrist fuer Zustellversuche und Bounces,
- Zugriff nur fuer erforderliche Administratoren,
- externe E-Mail nur bei administrativ freigegebenem Kanal `Email`,
- getrennte rechtliche Bewertung fuer spaetere Marketingnachrichten.

System- und Fachmeldungen duerfen keine Passwoerter, Resetcodes, Sessionwerte,
Tokens oder nicht erforderliche Personendaten enthalten.


## 10. Observability und Auditvertrag

Die Funktion ist erst vollstaendig, wenn Versand, Fehlerpfade und unklare
Ausgaenge beobachtbar sind.

### 10.1 Strukturierte Abschlusslogs

Kontrollierte Ereignisse sollen mindestens abdecken:

```text
email_delivery_queued
email_delivery_attempt_started
email_delivery_submitted
email_delivery_deferred
email_delivery_rejected
email_delivery_unknown
email_delivery_bounced
email_delivery_recovered
```

Zulaessige Felder sind beispielsweise Instanz, kontrollierter Meldungstyp,
Versuchnummer, Status, Dauer, Postfix-Ergebnisklasse und begrenzter Fehlercode.
E-Mail-Adresse, Personenname, Betreff, Body, SMTP-Freitext und vollstaendige
Payload bleiben ausgeschlossen. IDs mit Personenbezug duerfen nur in der
geschuetzten, erforderlichen Auditprojektion und nicht als Metriklabel erscheinen.

### 10.2 Audit

Fuer jede externe Zustellwirkung wird der bestehende Auditvertrag auf Start,
Erfolg, Ablehnung und unklaren Ausgang erweitert. Das Audit speichert keine
Nachrichteninhalte und keine Klartextadresse. Ein spaeterer Bounce ist als neuer
kontrollierter Zustandsuebergang mit Bezug auf die Zustellung zu erfassen.

### 10.3 Metriken und Alarmierung

Vorgesehene aggregierte Metriken:

- Anzahl Zustellversuche nach kontrolliertem Ergebnis,
- aktuell wartende ePiber-Outbox-Auftraege,
- Alter des aeltesten Auftrags,
- Groesse und Alter der Postfix-Queue,
- temporaere und permanente Fehlerquote,
- Anzahl unklarer Ausgaenge,
- Anzahl Bounces nach grober kontrollierter Klasse,
- Zeitpunkt des letzten erfolgreichen Versands.

Keine Metrik verwendet Empfaenger, Domain, Personen-ID, Nachrichten-ID, Betreff
oder SMTP-Freitext als Label. Fuer Queue-Alter, dauerhafte Fehler, unbekannte
Ausgaenge und ausbleibenden Erfolg sind Grafana-Alerts und Runbooks vorzusehen.


## 11. Firewall, TLS und Netzwerk

Fuer reinen Ausgangsversand:

- ausgehendes TCP 25 zu fremden MX-Servern erlauben,
- DNS-Aufloesung fuer Postfix sicherstellen,
- keinen neuen eingehenden Mailport freigeben,
- lokale Einlieferung ausschliesslich ueber Socket oder Loopback,
- bestehenden HTTPS-/Caddy-Betrieb unveraendert lassen.

Postfix verwendet bei ausgehender Zustellung opportunistisches STARTTLS und
prueft das sichere Verhalten bei nicht verfuegbarem TLS nach der festgelegten
Policy. Eine pauschale Pflicht zu TLS kann bei normaler Internet-Mail zu
Unzustellbarkeit fuehren und wird daher nicht ohne abgestimmtes Konzept gesetzt.

Wird spaeter eine eigene Bounce-MX-Annahme aktiviert, kommen mindestens hinzu:

- eingehendes TCP 25,
- eigener TLS-Zertifikats- und Erneuerungsweg fuer Postfix,
- strikte Empfaenger-Allowlist,
- Groessen-, Verbindungs- und Rate Limits,
- sichere MIME-/DSN-Verarbeitung,
- Monitoring des eingehenden Dienstes.

Caddy-Schluessel werden nicht ohne eigenes Berechtigungs- und
Erneuerungskonzept mit Postfix geteilt.


## 12. Test- und Abnahmeplan

### 12.1 Automatisierte Anwendungstests

- Meldung und Zustellauftrag werden vor dem Adapteraufruf atomar persistiert.
- Ein wiederholter Fachvorgang erzeugt keine zweite Meldung oder Outbox-Zeile.
- Worker-Leases werden nach Prozessabbruch sicher wieder freigegeben.
- Lokale Annahme, temporaerer Fehler, permanente Ablehnung und Timeout werden
  korrekt klassifiziert.
- Ein Abbruch vor und nach Postfix-Annahme deckt den `unknown`-Pfad ab.
- Leere und ungueltige Kontaktadressen deaktivieren nur den externen Kanal.
- Header-Injection, freie Absender und uebergrosse Inhalte werden abgelehnt.
- Nachrichtentext und E-Mail-Adresse erscheinen nicht in Logs oder Metriken.
- Rate Limits und Kill-Switch funktionieren.
- Audit enthaelt Start, Erfolg, Ablehnung und unklaren Ausgang.
- Tests verwenden einen lokalen Fake-SMTP-Server und versenden nie unbeabsichtigt
  E-Mails ins Internet.

### 12.2 Infrastrukturtests

- Forward- und Reverse-DNS stimmen ueberein.
- SPF hat genau einen Record und autorisiert alle legitimen Absender.
- DKIM-Signatur ist gueltig und aligned.
- DMARC besteht in der vorgesehenen Policy.
- Ausgehendes TCP 25 funktioniert fuer mehrere unabhaengige MX-Ziele.
- Postfix ist von extern kein Open Relay.
- Keine oeffentlichen Ports 465 oder 587 sind aktiv.
- Neustart von ePiber, Postfix und DKIM-Signer verliert keine Auftraege.
- Queue-Limits, Dateirechte, systemd-Hardening und Logrotation sind wirksam.
- Backup und Restore der erforderlichen Konfiguration sind getestet.

### 12.3 Zustelltests

Kontrollierte Testpostfaecher sollen mindestens Gmail, Microsoft/Outlook, GMX
und den bestehenden Domain-Mailanbieter abdecken. Geprueft werden:

- Inbox- oder Spamablage,
- sichtbarer Absender und Reply-To,
- SPF, DKIM und DMARC in den empfangenen Headern,
- Text- und HTML-Darstellung auf Desktop und Mobilgeraet,
- Umlaute und Sonderzeichen,
- Linkziele,
- temporaere Ablehnung und spaetere Zustellung,
- permanente Unzustellbarkeit und Bounceweg,
- keine Dublette nach Prozess- oder Serverneustart.

Ein externer Mailtestdienst kann zusaetzlich verwendet werden, darf aber nur
kontrollierte Testdaten erhalten.


## 13. Stufenweiser Rollout

### Phase 0: Machbarkeit

1. Hosterfreigabe, Port 25 und PTR-Aenderbarkeit bestaetigen.
2. Blocklisten- und IP-Reputationspruefung durchfuehren.
3. Bestehende DNS- und Mailanbieterwege vollstaendig erheben.
4. Bounce- und Antwortadresse festlegen.
5. Versandmengen, Meldungstypen und Rechtsgrundlagen freigeben.

### Phase 1: Lokale Infrastruktur ohne echten Empfaengerversand

1. Postfix und genau einen DKIM-Signer installieren und haerten.
2. Lokale Einlieferung und Fake-/Testziel verwenden.
3. Queue, Logs, Metriken und Kill-Switch pruefen.
4. Open-Relay- und Porttests durchfuehren.

### Phase 2: DNS und kontrollierte Direktzustellung

1. Mailhostname und PTR setzen.
2. DKIM veroeffentlichen.
3. SPF kontrolliert anpassen.
4. DMARC mit `p=none` aktivieren.
5. Nur explizite technische Testadressen freigeben.
6. Zustellung und Reputation ueber mehrere Tage beobachten.

### Phase 3: ePiber-Outbox und Email-Adapter

1. Persistentes Zustellmodell und Worker implementieren.
2. Dummyadapter durch lokale Postfix-Einlieferung ersetzen.
3. Status-, Retry-, Recovery-, Audit- und Datenschutzpfade testen.
4. PAJ nur fuer freigegebene Testpersonen aktivieren.

### Phase 4: Begrenzter Produktivbetrieb

1. Kleine Empfaengergruppe und geringe Rate verwenden.
2. Queue, Bounces, Spamablage und DMARC-Berichte taeglich kontrollieren.
3. Versandvolumen langsam erhoehen; keine kuenstlichen Warmup-Nachrichten senden.
4. Bei Reputationseinbruch oder Fehlerrate sofort Kill-Switch aktivieren.

### Phase 5: Regulaerer Betrieb

1. Live-Aktivierung nach PAJ-Abnahme.
2. Runbooks, Restore und Verantwortlichkeiten abnehmen.
3. DMARC nach stabiler Beobachtung kontrolliert verschaerfen.
4. Regelmaessige Queue-, Blocklisten-, Schluessel- und Zustellkontrollen planen.


## 14. Abschaltung und Rueckfallplan

Der externe Kanal muss unabhaengig von der internen Inbox deaktivierbar sein.
Beim Rueckfall:

1. Neue E-Mail-Auftraege werden nicht mehr erzeugt oder bleiben kontrolliert
   `not_configured`; interne Meldungen funktionieren weiter.
2. Der Worker wird geordnet gestoppt.
3. Bereits an Postfix uebergebene Nachrichten werden je nach Vorfall kontrolliert
   ausgetragen oder aus der Queue entfernt; die Entscheidung wird auditiert.
4. Ausgehendes TCP 25 kann an der Firewall gesperrt werden.
5. DKIM-Schluessel werden bei Kompromittierung rotiert und alte DNS-Schluessel
   erst nach Ablauf noch wartender Nachrichten entfernt.
6. SPF und DMARC werden nur angepasst, wenn der Versandweg dauerhaft entfaellt.
7. Ursache, betroffene Zeitspanne und unklare Ausgaenge werden datensparsam
   ermittelt.

Ein Wechsel auf ein externes Relay ist nicht Teil des Zielplans, bleibt aber bei
dauerhaft unzureichender Direktzustellbarkeit eine spaetere, neu freizugebende
Architekturentscheidung.


## 15. Betriebsaufgaben nach Aktivierung

- Postfix-Queue und aeltesten Auftrag ueberwachen.
- DMARC-Berichte regelmaessig auswerten.
- Bounces und Beschwerden bearbeiten.
- Blocklistenstatus und Reputation kontrollieren.
- DKIM-Schluessel geplant rotieren.
- Postfix, Signaturdienst und Betriebssystem aktuell halten.
- Versandlimits und Empfaengerqualitaet pruefen.
- Nicht mehr erreichbare Adressen kontrolliert sperren.
- Restore und Kill-Switch regelmaessig testen.
- Keine Marketing- oder Massenmailnutzung ohne separates fachliches,
  datenschutzrechtliches und technisches Konzept zulassen.


## 16. Vor Umsetzung noch festzulegende Punkte

1. Endgueltiger Mailhostname: vorgeschlagen `smtp.epiber.at`.
2. Konkrete Absender-, Reply-To-, Bounce- und DMARC-Berichtadressen.
3. Weiterverwendung des bestehenden MX fuer Bounces oder eigene Bounce-Subdomain.
4. Ausschliesslicher IPv4-Versand oder vollstaendig eingerichtetes IPv6.
5. DKIM-Signaturdienst und Schluesselalgorithmus entsprechend aktueller
   Empfaengerkompatibilitaet.
6. Maximale Versandrate, Queue-Lebensdauer und Retryzeiten.
7. Aufbewahrungsfristen fuer Zustellversuche, Queue-Korrelationen und Bounces.
8. Exakte Semantik und Sichtbarkeit der externen Zustellstatus.
9. Verantwortliche Personen fuer DNS, Serverbetrieb, Bounces, DMARC und
   Sicherheitsvorfaelle.
10. Welche ePiber-Meldungstypen initial E-Mail ausloesen duerfen.


## 17. Dokumentationsziele bei spaeterer Umsetzung

Beim freigegebenen Main-Versionssprung sind mindestens folgende Ziele zu
pruefen und entsprechend dem tatsaechlich implementierten Stand zu pflegen:

- `Project/FACHKONZEPT.txt` fuer Zweck, Empfaenger und Kanalregeln,
- `Project/software/ARCHITEKTUR.txt` fuer Outbox, Worker, Status und Datenfluss,
- `Project/software/DATENBANK.txt` fuer Zustell- und Retrypersistenz,
- `Project/software/ENDPOINTS.txt`, falls Vertraege oder Projektionen betroffen
  sind,
- betroffene Seitendokumentation fuer sichtbare Zustellstatus oder Einstellungen,
- `Project/server-configs/SERVER-SETUP.txt` und `SERVER-DOKU.txt`,
- versionierte Postfix-, DKIM-, systemd-, Firewall- und Observabilityvorlagen,
- Dashboard-, Alert- und Runbook-Dokumentation,
- verpflichtendes Branch- und Main-Changelog nach dem Projektworkflow.

Diese Liste ist eine Uebernahmehilfe und keine Vorwegnahme des spaeteren
kanonischen Sollstands.
