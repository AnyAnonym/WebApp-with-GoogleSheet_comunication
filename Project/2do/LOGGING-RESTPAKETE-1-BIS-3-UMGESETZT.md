# Logging-Restpakete 1 bis 3 umgesetzt

Stand: 09.08.2026
Commitstand: `4.3.0-paj-1-6`

## Ergebnis

Die im Vorabplan `LOGGING-RESTPAKETE-1-BIS-3-PLAN.md` festgelegten Pakete 1 bis
3 sind im Arbeitsstand umgesetzt. Prometheus/Grafana/Loki/Alloy und die
praktische Systemabnahme waren nicht Teil dieses Auftrags.

## Paket 1: Sichere Frontenddiagnose

- `Frontend/JS/diagnostics.js` ist der einzige Browserzugriff auf `console`.
- Der Adapter erzwingt benannte Ereignisse, Levelsteuerung, Feld-, Tiefen- und
  Laengenlimits sowie rekursive Redaction sensibler Schluessel und Textmuster.
- Fehler werden nur auf `code`, `category`, optionale `supportId` und eine
  neutrale Kategorienachricht projiziert. Stack, Details, Request-Payloads und
  frei formulierte Fehlermeldungen werden nicht ausgegeben.
- Alle 42 bisherigen direkten `console.*`-Aufrufe der Frontendmodule verwenden
  den Adapter. Die statische Pruefung verhindert neue direkte Aufrufe ausserhalb
  des Adapters.
- Das Profilmodal entfernt beim Schliessen, Logout und Identitaetswechsel Name,
  Kontaktdaten, Aktionen, Scope und gebundene Aktionshandler aus dem DOM.
- Der Adapter uebertraegt bei aktivierter serverseitiger Policy gebuendelt nur
  allowlist-basierte technische Projektionen. Globale Fehler-, Ressourcen-,
  Seitenlade-, WebSocket- und RPC-Lifecycle-Events sind vorbereitet.

## Grafana-Vorbereitung: Zentrale Frontenddiagnose

- `FrontendLoggingService` persistiert globale Level-, Sampling-, Batch-, Flush-
  und Retentionvorgaben sowie automatisch ablaufende Zielpersonen revisioniert in
  `STATE_FILE`.
- `POST /api/frontend-events` reichert angenommene Events serverseitig mit
  Personen-ID, Klartextname, Rolle und Quell-IP an. Der Browser liefert keine
  dieser Identitaetsfelder selbst.
- Anonyme Events sind separat abschaltbar. Eventnamen, Level und Felder besitzen
  eine feste Allowlist und ein separates Rate-Limit.
- `adminLogging.html` erlaubt Admins globale Einstellungen sowie temporaere
  Zielpersonen mit Level, Dauer, Restzeit, Ablauf und Ersteller zu verwalten.
- Zielpersonen erhalten die Policy ueber den periodischen Sessionrefresh und
  sehen waehrenddessen einen neutralen lokalen Hinweis mit Ablaufzeit.
- Angenommene Eintraege erscheinen als `frontend_client_event` im strukturierten
  Backendlog. `retentionClass` und `retentionDays` bereiten Alloy/Loki vor; eine
  tatsaechliche Loki-Aufbewahrung ist damit noch nicht installiert.

## Paket 2: Ende-zu-Ende-Korrelation

- Jeder HTTP-Request erhaelt eine serverseitige UUID im Header `X-Request-ID`.
  Fehlerantworten verwenden dieselbe UUID als `supportId`.
- Routing-, Methoden-, Parse-, Validierungs-, Auth- und Rate-Limit-Fehler laufen
  durch denselben Korrelationspfad.
- Jeder HTTP-Abschluss erzeugt `http_request_completed` mit ID, Methode, Route,
  Status, Dauer, Ergebnis und kontrolliertem Fehlercode.
- WebSocket-Client-Request-ID und serverseitige Support-UUID sind getrennt. Jeder
  korrelierbare Abschluss erzeugt `ws_request_completed` mit beiden IDs.
- Pro Socket werden atomare, nach Abschluss unveraenderliche Diagnosedatensaetze
  gespeichert. `lastRequest` zeigt den letzten Abschluss, `requestHistory`
  hoechstens die letzten 20 Abschluesse; parallele Requests vermischen sich nicht.
- Audit-Request- und Event-ID verwenden bei WebSocket-Writes weiterhin die
  serverseitige Support-UUID.

## Paket 3: Poller, Readiness und Status

- Sheet-Pollergebnisse unterscheiden `applied`, `ignored_stale`, `failed` und
  `recovered` und fuehren Dauer, Fehlercode, Fehlerfolge und Ausfalldauer.
- Identische Sheet- und Court-Fehler werden beim ersten Auftreten und danach nur
  periodisch als Zusammenfassung protokolliert. Recovery ist ein eigenes Ereignis.
- Court-Stale richtet sich nach dem Alter des letzten Erfolgs. Ein einzelner
  Fehler innerhalb des Frischefensters blockiert Readiness nicht sofort.
- Eine gueltige bestehende Adminsession kann `/status` bei stale Personen ueber
  den letzten erfolgreich geladenen aktiven Admin-Snapshot erreichen. Die Antwort
  kennzeichnet `authorization.roleSource` als `current` oder `last_known_good`.
- Ein dauerhafter HTTP-Server-Error-Handler protokolliert auch Fehler nach
  erfolgreichem Listen strukturiert.

## Automatisierte Abdeckung

- Frontendadapter: Level, Eventnamen, Redaction, Grenzen und Fehlerprojektion.
- Profilmodal: Entfernen personenbezogener Inhalte und Abbruch der Handler.
- HTTP: `X-Request-ID`, Body-/Header-Korrelation und suchbares 405-Ereignis.
- WebSocket: getrennte IDs, Abschlussereignis und unvermischte parallele Historie.
- DataStore/Sheet-Poller: Fencing, Outcomes, Suppression und Recovery.
- Court-Poller: Fehlerfolge, Zusammenfassung, Recovery und erfolgszeitbasierte
  Stale-Berechnung.
- Auth/Status: Last-known-good-Rolle nur opt-in, nur mit vorherigem Snapshot und
  nur innerhalb einer gueltigen Session.
- Server-Lifecycle: strukturierter Laufzeitfehler bei bereits lauschendem Server.

## Betriebsfolgen

- Browserdiagnose wird nur bei aktivierter globaler oder zielbezogener Policy an
  das Backend uebertragen. Ohne Policy bleibt sie lokal.
- Erfolgreiche HTTP- und korrelierbare WebSocket-Auftraege erzeugen nun je ein
  strukturiertes Abschlussereignis und erhoehen damit das journald-Volumen.
- `X-Request-ID` beziehungsweise `supportId` ist der primaere Suchschluessel fuer
  HTTP; bei WebSocket ist `supportId` serverseitig und nicht mehr aus Connection-
  und Client-ID zusammengesetzt.
- `/status` enthaelt weiterhin privilegierte fluechtige Diagnosedaten und darf
  nicht ungefiltert in oeffentliche Tickets uebernommen werden.
- Frontend-Events mit Name, stabiler ID und IP sind personenbezogene Betriebsdaten
  und duerfen nur autorisierte Betreiber einsehen. In Loki bleiben diese Werte
  JSON-Felder und werden keine Labels.

## Abschlusspruefung

- `npm run build`: statische Pruefung und alle 132 Tests erfolgreich.
- `git diff --check`: erfolgreich.
- Direkte Frontend-`console.*`-Aufrufe existieren nur im zentralen Adapter.
