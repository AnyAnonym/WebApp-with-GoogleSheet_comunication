# Umsetzungsplan Logging-Restpakete 1 bis 3

Stand: 07.08.2026
Arbeitsstand: `4.3.0-paj-1-5-x`
Zielcommit: `4.3.0-paj-1-6`

## Auftrag

Die nach Umsetzung der Logging-Etappen A bis D verbliebenen priorisierten Pakete
1 bis 3 werden in diesem Arbeitsstand umgesetzt:

1. Frontend-Datenschutz und Fehlerlogs bereinigen.
2. Request-Korrelation und Support-ID-Suche vervollstaendigen.
3. Poller-/Readiness-Diagnose und geschuetzten Statuszugriff korrigieren.

Prometheus, Grafana, Loki, Alloy und die praktische PAJ-/PK-/Live-Rolloutabnahme
bleiben ausdruecklich Folgearbeit.

## Paket 1: Sichere Frontenddiagnose

- Einen zentralen Frontend-Diagnoseadapter mit benannten Ereignissen,
  Levelsteuerung, Feldbegrenzung und rekursiver Redaction einfuehren.
- Direkte `console.*`-Aufrufe der fachlichen Frontendmodule auf den Adapter
  umstellen; vollstaendige Error-Objekte, personenbezogene Sperrzeiten und
  unkontrollierte Freitexte duerfen nicht mehr ausgegeben werden.
- Fehler nur als kontrollierte Projektion aus `code`, `category`, `supportId`
  und neutraler Meldung protokollieren; keine Request-Payloads.
- Profilname, Kontaktfelder, Aktionen und gebundene Handler beim Schliessen,
  Logout und Identitaetswechsel aus dem DOM entfernen.
- Tests fuer Redaction, Fehlerprojektion und Profilbereinigung ergaenzen.

## Paket 2: Ende-zu-Ende-Korrelation

- Fuer jeden HTTP-Request eine serverseitige UUID erzeugen, als
  `X-Request-ID` zurueckgeben und bei jedem Abschluss mit Route, Status, Dauer,
  Ergebnis und kontrolliertem Fehlercode strukturiert protokollieren.
- Method-, Parse-, Validierungs-, Auth- und Rate-Limit-4xx erhalten denselben
  suchbaren Request-/Support-Identifier wie ihre Antwort.
- WebSocket-Client-Request-ID und serverseitige Correlation-ID trennen; die
  Response traegt die serverseitige Support-ID, Logs behalten beide IDs.
- Den gemeinsam mutierten `lastRequest`-Slot durch atomar abgeschlossene
  per-Request-Datensaetze und eine kleine begrenzte Historie ersetzen.
- Audit-Request-IDs verwenden weiterhin die serverseitige Correlation-ID.
- Tests fuer HTTP-Header/Body-Korrelation, 4xx-Suchbarkeit, parallele WS-Requests
  und unvermischt bleibende Diagnosedatensaetze ergaenzen.

## Paket 3: Poller, Readiness und Status

- Sheet-Pollergebnisse als `applied`, `ignored_stale`, `failed` und `recovered`
  unterscheiden; Dauer, Fehlercode, Fehlerfolge und Ausfalldauer erfassen.
- Wiederholte identische Pollerfehler nur beim ersten Auftreten und danach
  periodisch zusammengefasst loggen; Recovery als eigenes Ereignis ausgeben.
- Court-Readiness am Alter des letzten Erfolgs ausrichten. Ein einzelner Fehler
  darf eine noch frische Quelle nicht sofort stale setzen.
- Court-Ausfallbeginn, Fehlerfolge, periodische Zusammenfassung und Recovery
  diagnostizierbar machen.
- Admin-`/status` darf bei stale `Personen` ueber eine gueltige Session und den
  letzten bekannten Cache weiterhin erreichbar sein; die verwendete Rolle ist
  dann explizit ein Last-known-good-Snapshot innerhalb der bestehenden Session.
- Dauerhafte HTTP-Serverfehler nach erfolgreichem Listen strukturiert behandeln.
- Tests fuer Fencing-Ergebnisse, Fehlerunterdrueckung/Recovery, Court-Stale-Alter,
  stale-Personen-Statuszugriff und Serverfehler-Lifecycle ergaenzen.

## Bewusst nicht enthalten

- Prometheus-`/metrics`, Node Exporter, Grafana, Loki und Alloy.
- Caddy-Access-Logs und zentrale Uebertragung von Frontendfehlern.
- Praktische Dauerbetriebs-, Ausfall-, Backup-/Restore- und Rollbackabnahme.
- Automatische Audit-Loeschung oder -Anonymisierung und kryptografische
  Manipulationsnachweise.

## Abschlussartefakte

Nach der Umsetzung werden zwei weitere Dateien unter `Project/2do/` angelegt:

- `LOGGING-RESTPAKETE-1-BIS-3-UMGESETZT.md`: tatsaechlich umgesetzter Umfang,
  Tests und Betriebsfolgen.
- `LOGGING-RESTPAKETE-OFFEN.md`: verbleibende Aufgaben einschliesslich der
  bewusst verschobenen Pakete 4 und 5.

## Abnahmekriterien

- Keine direkten Frontend-`console.*`-Aufrufe ausserhalb des zentralen Adapters.
- Keine personenbezogenen Sperrzeiten, vollstaendigen Error-Objekte, Cookies,
  Tokens, Passwortwerte oder Request-Payloads in Browser-/Backendlogs.
- Jede ausgegebene HTTP-/WS-Support-ID besitzt ein korrespondierendes
  strukturiertes Abschlussereignis.
- Parallele WS-Requests koennen ihre Diagnosedaten nicht vermischen.
- Einzelne Courtfehler innerhalb des Frischefensters blockieren Readiness nicht.
- Wiederholte Pollerfehler werden begrenzt, Recoveries eindeutig protokolliert.
- Adminstatus bleibt mit gueltiger bestehender Adminsession bei stale
  Personendaten erreichbar.
- Vollstaendige statische Pruefung und Testsuite sind erfolgreich.
