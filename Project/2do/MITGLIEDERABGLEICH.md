# Mitgliederabgleich und Normalisierung der Personendaten

Stand: 18.08.2026
Analysierter Anwendungsstand: ePiber v4.4.6
Status: Arbeitsplan; noch nicht implementiert
Gegenstand: Normalisierung des ePiber-Personenbestands und spaeterer CSV-Abgleich

Diese Datei dokumentiert die im Planungsgespraech erarbeiteten Anforderungen,
Analyseergebnisse, Entscheidungen, offenen Punkte und die vorgesehene
Umsetzungsreihenfolge. Sie ist eine nicht-kanonische Arbeitsgrundlage unter
`Project/2do/`. Fachkonzept, technische Soll-Dokumentation und Seitendokumente
werden erst im jeweiligen freigegebenen Umsetzungsschritt angepasst.

Wichtig: Die Umsetzung wird bewusst in zwei fachlich und technisch getrennte
Seiten aufgeteilt:

1. Normalisierung der bereits in ePiber vorhandenen Personendaten.
2. Import und Abgleich eines CSV-Exports aus der externen Mitgliederverwaltung.

Nach Implementierung und Erprobung der Normalisierung auf PAJ wird die
Normalisierung auch im Live-System durchgefuehrt. Danach gilt ein verbindlicher
Stopppunkt. Die Importseite wird erst nach einem neuen ausdruecklichen Auftrag
entwickelt.


## 1. Ziel und fachlicher Hintergrund

Der Verein fuehrt Mitglieder in einem externen Verwaltungssystem. ePiber fuehrt
im Google-Sheets-Tab `Personen` die fuer Tennisbetrieb, Anmeldung,
Authentifizierung, Ranglisten, Matches und Anzeige benoetigten Personen.

Beide Bestaende sollen wiederholt abgeglichen werden koennen. Der externe Export
ist eine CSV-Datei. Der Admin soll spaeter:

- eine lokale CSV-Datei im Browser auswaehlen,
- den Export mit dem aktuellen ePiber-Bestand vergleichen,
- ausschliesslich Unterschiede sehen,
- neue, weggefallene, geaenderte und unklare Personen unterscheiden,
- bei abweichenden Werten zellenweise entscheiden, welcher Wert gelten soll,
- die ausgewaehlten Aenderungen vor dem Schreiben nochmals pruefen,
- nur explizit bestaetigte Aenderungen nach ePiber uebernehmen.

Eine in der externen Datei nicht mehr vorhandene Person wird nicht geloescht.
Wegen bestehender Querverweise in Matches, Ranglisten und Eintragungen wird bei
einer bestaetigten Deaktivierung lediglich `Aktiv` von `1` auf leer gesetzt.


## 2. Verbindliche Grundentscheidungen

### 2.1 Zwei getrennte Administrationsseiten

Die Aufgaben werden nicht in eine einzige Importoberflaeche vermischt.

Seite 1: Daten normalisieren

- arbeitet ausschliesslich mit dem aktuellen ePiber-Tab `Personen`,
- benoetigt keine CSV-Datei,
- findet formale und semantische Inkonsistenzen im eigenen Bestand,
- zeigt Korrekturvorschlaege,
- fuehrt nur vom Admin ausgewaehlte Korrekturen aus.

Seite 2: Daten importieren

- wird erst nach erfolgreicher Normalisierung entwickelt,
- liest eine externe CSV-Datei lokal im Browser,
- vergleicht Import und ePiber-Bestand,
- zeigt nur Unterschiede,
- erlaubt die zellenweise Auswahl der Zielwerte.

### 2.2 CSV-Verarbeitung im Browser

Die rohe CSV-Datei wird nicht zum Backend hochgeladen. Dateiauswahl, Dekodierung,
CSV-Parsing, Normalisierung fuer den Vergleich und Differenzbildung erfolgen im
Browser.

Nur die vom Admin bestaetigten, geschlossenen Aenderungsobjekte werden an eine
neue admin-geschuetzte Backend-Schnittstelle gesendet. Das Backend bleibt fuer
Autorisierung, Validierung, Konfliktpruefung, ID-Vergabe, Google-Sheets-Writes,
Developer Metadata, Cache-Aktualisierung und Auditierung verantwortlich.

Ein direkter Google-Sheets-Zugriff aus dem Browser ist ausgeschlossen. Google-
Zugangsdaten duerfen niemals an das Frontend gelangen.

### 2.3 Bestehende ePiber-ID bleibt stabil

Die bestehende Spalte `Personen.ID` bleibt die interne ePiber-Primar-ID und die
serverseitige Principal-ID. Vorhandene IDs werden nicht durch IDs des externen
Systems ersetzt.

Stattdessen wird spaeter eine neue Spalte `ExternalID` im Tab `Personen`
eingefuehrt. Sie nimmt die externe Datensatz-ID aus Spalte 57 `[Id]` auf.

Gruende gegen eine Umschreibung bestehender ePiber-IDs:

- `Personen.ID` ist zugleich die Login- und Sessionidentitaet.
- `Matches1` referenziert Personen in `Spieler1ID` bis `Spieler4ID`.
- `RL-Platzierung` referenziert Personen in `PersonID`.
- `EntryList` referenziert Personen in `PersonenID`.
- Personenzeilen werden durch Google Developer Metadata
  `epiberRecord=players:<ID>` stabil adressiert.
- persistente Court-Zustaende enthalten `homePlayerIds` und `guestPlayerIds`.
- SQLite-Sessions, Resetnachweise, Loggingziele und Idempotenzdaten enthalten
  oder verwenden Personen-IDs.
- die Grafana-Identitaet wird aus Instanz und Personen-ID gebildet.
- Audit- und Betriebslogs enthalten historische ID-Snapshots.

Im analysierten PAJ-Stand waeren bei einer Primaer-ID-Migration unter anderem
folgende Google-Sheets-Bestaende betroffen:

| Tabelle | Zeilen | Personenreferenzen |
|---|---:|---|
| `Matches1` | 259 | `Spieler1ID` bis `Spieler4ID` |
| `RL-Platzierung` | 66 | `PersonID` |
| `EntryList` | 181 | `PersonenID` |

Die separate `ExternalID` vermeidet diese riskante Gesamtmigration und schafft
trotzdem einen stabilen Schluessel fuer spaetere Exporte.

### 2.4 Vergabe neuer interner ePiber-IDs

Neue Personen erhalten weiterhin eine interne numerische ePiber-ID. Die Regel
lautet:

```text
neue ID = hoechste aktuell vorhandene numerische Personen-ID + 1
```

Luecken werden nicht aufgefuellt. Im analysierten PAJ-Bestand war die hoechste
ID `1032`; zu diesem Zeitpunkt waere die naechste ID `1033` gewesen.

Die Vergabe darf nicht vom Browser auf Basis eines zuvor geladenen Snapshots
erfolgen. Das Backend muss die aktuelle Tabelle innerhalb der serialisierten
`players`-Write-Queue erneut lesen und die ID dort vergeben. Dadurch koennen zwei
parallele Adminvorgaenge nicht dieselbe ID erhalten.

Neue Personen erhalten zusaetzlich die aus dem Import stammende `ExternalID`.

### 2.5 Technische Personen bleiben erhalten

Die ePiber-Sonderzeilen `-`, `Der Piber` und die Testpersonen `A` bis `FF` werden
nicht entfernt und nicht stillschweigend ausgeblendet. Sie duerfen im
Normalisierungs- und Importabgleich erscheinen.

Die Oberflaechen erhalten Filter, damit aktive, inaktive und technische Personen
gezielt ein- oder ausgeblendet werden koennen. Eine technische Person darf nicht
allein deshalb automatisch deaktiviert oder veraendert werden, weil sie in der
externen Mitgliederverwaltung fehlt.


## 3. Analysierter ePiber-Personenbestand

Der aktuelle PAJ-Tab `Personen` wurde am 18.08.2026 ausschliesslich lesend ueber
die bestehende geschuetzte Google-Sheets-Konfiguration analysiert. Es wurden
keine Sheetdaten veraendert und keine Zugangsdaten ausgegeben.

### 3.1 Struktur

Der analysierte Bestand enthaelt 177 Personenzeilen. Vorhandene fachlich
relevante Spalten sind unter anderem:

- `ID`
- `Nachname`
- `Vorname`
- `TelefonMobil`
- `E-Mail`
- `Ort`
- `Adresse`
- `PLZ`
- `GeburtsDatum`
- `GeschlechtID`
- `Aktiv`
- `Role`

Zusaetzlich bestehen Passwort- und Sicherheitsfelder. Diese duerfen in einer
allgemeinen Personenverwaltung weder gelesen noch an das Frontend projiziert
werden.

### 3.2 ID-Bestand

- 177 befuellte IDs
- 177 eindeutige IDs
- alle IDs numerisch
- hoechste ID zum Analysezeitpunkt: `1032`

### 3.3 Aktivstatus

Gefundene Werte:

| Wert | Anzahl | Bedeutung |
|---|---:|---|
| `1` | 142 | aktiv |
| leer | 33 | inaktiv |
| `0` | 2 | technisch inaktiv, aber nicht kanonisch |

Fuer ePiber gilt als Zielregel weiterhin:

- `1` bedeutet aktiv,
- leer bedeutet inaktiv,
- `0` soll nach Freigabe der Normalisierungsregel auf leer normalisiert werden.

### 3.4 Geschlecht

Das Sheet verwendet derzeit den Header `GeschlechtID`, waehrend Code und
Dokumentation den Header `Geschlecht` erwarten. Dadurch wird das Geschlecht von
der aktuellen Anwendung nicht ueber den vorgesehenen Parser gelesen und in
Profilprojektionen faktisch leer behandelt.

Gefundene Werte unter `GeschlechtID`:

| Wert | Anzahl | bisherige Bedeutung |
|---|---:|---|
| `1` | 104 | maennlich |
| `2` | 38 | weiblich |
| `3` | 1 | Sonderwert bei der technischen Person `Der Piber` |
| leer | 34 | nicht gesetzt beziehungsweise technische Zeilen |

Vorgesehene, aber vor Implementierung nochmals zu bestaetigende Richtung:

- Header kontrolliert von `GeschlechtID` auf `Geschlecht` umstellen,
- `1` und `2` als bestehende Fachwerte erhalten,
- `3` nicht automatisch umdeuten,
- leere Werte nicht ohne sichere fachliche Grundlage ergaenzen.

### 3.5 Geburtsdatum

- 142 Werte im Format `TT.MM.JJJJ`
- 35 leere Werte, vor allem bei technischen oder unvollstaendigen Datensaetzen
- keine abweichenden befuellten Formate im analysierten Bestand

Das genaue kanonische Speicherformat muss vor der Implementierung trotzdem
verbindlich festgelegt werden. Ein Vergleichsparser muss zumindest das bestehende
Format `TT.MM.JJJJ` und gegebenenfalls historische `YYMMDD`-/`YYYYMMDD`-Werte
sicher behandeln koennen.

### 3.6 Leerzeichen und formale Auffaelligkeiten

Es wurden zwoelf Personenzeilen mit fuehrenden oder nachgestellten Leerzeichen in
mindestens einem relevanten Feld gefunden. Betroffen sind unter anderem:

- Vorname
- Nachname
- E-Mail
- Ort
- Adresse

Ein Datensatz kann mehrere betroffene Felder enthalten. Diese Werte sollen auf
der Normalisierungsseite sichtbar gemacht, aber erst nach bestaetigter Regel und
Adminauswahl geschrieben werden.

### 3.7 E-Mail

- 87 leere E-Mail-Felder
- drei E-Mail-Felder mit fuehrendem oder nachgestelltem Leerraum
- eine nach dem aktuellen ePiber-Vertrag ungueltige E-Mail-Adresse bei
  Personen-ID `71`

Die ungueltige E-Mail darf nicht automatisch geraten oder korrigiert werden. Die
Normalisierungsseite muss den Fehler anzeigen und eine manuelle Entscheidung
verlangen.

### 3.8 Weitere Leerwerte

Zum Analysezeitpunkt waren unter anderem folgende Felder leer:

| Feld | Leere Werte |
|---|---:|
| `Vorname` | 33 |
| `TelefonMobil` | 36 |
| `E-Mail` | 87 |
| `GeburtsDatum` | 35 |
| `Adresse` | 41 |
| `PLZ` | 38 |
| `Ort` | 38 |

Diese Zahlen enthalten technische Datensaetze. Ein leerer Wert ist nicht
automatisch ein Fehler. Die spaetere Normalisierungsrichtlinie muss je Feld
festlegen, wann leer erlaubt, auffaellig oder unzulaessig ist.


## 4. Analysierter externer CSV-Export

Analysierte lokale Datei: `export (4).csv`

Die Datei ist ein lokales Analyseobjekt und kein Projektbestandteil. Sie enthaelt
personenbezogene Kontakt-, Mitgliedschafts- und Finanzdaten und darf nicht in Git
aufgenommen werden.

### 4.1 Technische Struktur

- 171 Datensaetze
- 59 Spalten
- Semikolon als Trennzeichen
- alle Felder mit doppelten Anfuehrungszeichen umschlossen
- keine Zeile mit abweichender Spaltenzahl
- Kodierung Windows-1252 beziehungsweise ISO-8859-1, nicht UTF-8

Der spaetere Browserparser muss die Kodierung bewusst behandeln. Ein blindes
UTF-8-Einlesen fuehrt zu beschaedigten Umlauten und damit zu falschen Namen,
Orten, Adressen und Vergleichsschluesseln.

### 4.2 Fuer den Abgleich vorgesehene Importfelder

Der erste fachliche Feldumfang wurde wie folgt festgelegt:

- Nachname
- Vorname
- Telefon Mobil
- E-Mail
- Ort
- Adresse
- Postleitzahl
- Geburtsdatum
- Geschlecht

`Telefon Privat` wird vorerst nicht uebernommen. ePiber verwendet weiterhin
`TelefonMobil` als einziges Telefonnummernfeld.

Weitere CSV-Felder, insbesondere Bank-, Zahlungs-, Beitrags-, Mandats- und
Verwaltungsfelder, sind nicht Teil des ePiber-Abgleichs. Sie duerfen weder an das
Backend gesendet noch geloggt oder in Fehlerberichte aufgenommen werden.

### 4.3 Externe ID in Spalte 57

Die fuer eine kuenftige Zuordnung vorgesehene CSV-Spalte ist `[Id]` an Position
57 von 59.

Analyseergebnis:

| Eigenschaft | Ergebnis |
|---|---:|
| Datensaetze | 171 |
| befuellte `[Id]` | 171 |
| eindeutige `[Id]` | 171 |
| Duplikate | 0 |
| numerische Werte | 171 |
| Stellenzahl | immer 7 |
| kleinster Wert | `1000068` |
| groesster Wert | `1000494` |

Damit ist `[Id]` innerhalb dieses Exports vollstaendig und eindeutig.

Noch nicht nachgewiesen ist, dass dieselbe Person in spaeteren Exporten dauerhaft
dieselbe `[Id]` behaelt. Vor der verbindlichen Verwendung als alleiniger
Abgleichsschluessel muss die Stabilitaet anhand eines spaeteren zweiten Exports
oder einer verbindlichen Aussage des externen Systems bestaetigt werden.

Wenn die Stabilitaet bestaetigt ist, wird `[Id]` als `ExternalID` in ePiber
gespeichert. Die externe ID ersetzt nicht `Personen.ID`.

### 4.4 Statuswerte

Im Export wurden gefunden:

| Status | Anzahl |
|---|---:|
| Aktivmitglied | 159 |
| Passivmitglied | 12 |

Noch offen ist, ob und wie dieser externe Status auf `Personen.Aktiv` wirkt.
Bis zur fachlichen Entscheidung wird der Status nur analysiert und angezeigt.
Insbesondere darf `Passivmitglied` nicht automatisch als aktiv oder inaktiv in
ePiber interpretiert werden.

### 4.5 Qualitaetsbefunde im Export

- alle 171 Datensaetze besitzen Nachname und Vorname,
- alle 171 Datensaetze besitzen ein Geburtsdatum im formal gueltigen Format
  `TT.MM.JJJJ`,
- alle Kombinationen aus normalisiertem Vorname, Nachname und Geburtsdatum sind
  innerhalb des Exports eindeutig,
- alle 171 Datensaetze besitzen `Telefon Mobil`,
- `Telefon Privat` ist bei 162 von 171 Datensaetzen leer,
- eine Adresse ist leer,
- zwei PLZ-Felder enthalten keinen vierstelligen PLZ-Wert,
- mehrere Werte enthalten fuehrende oder nachgestellte Leerzeichen,
- alle E-Mail-Werte bestehen die syntaktische ePiber-E-Mail-Pruefung,
- neun E-Mail-Adressen werden jeweils von mehr als einer Person verwendet,
- eine Mobilnummer wird von zwei Personen verwendet.

Mehrfach verwendete E-Mail-Adressen sind fuer ePiber besonders relevant, weil
die E-Mail-Adresse der Loginname ist und nach Kanonisierung eindeutig sein muss.
Eine doppelte Export-E-Mail darf daher nicht ungeprueft fuer mehrere Personen
uebernommen werden. Der Import muss solche Konflikte markieren und die betroffenen
Zellen bis zu einer manuellen Entscheidung sperren.


## 5. Ergebnis des ersten Bestandsvergleichs

Der erste Vergleich erfolgte ausschliesslich analytisch. Personen wurden
vorlaeufig ueber normalisierten Vorname, Nachname und Geburtsdatum zugeordnet.

Ergebnis:

| Kategorie | Anzahl |
|---|---:|
| eindeutig zugeordnet | 138 |
| nur im Export | 33 |
| nur in ePiber | 39 |
| zugeordnet mit mindestens einer Abweichung | 69 |

Die 39 nur in ePiber gefundenen Zeilen enthalten auch die technischen Personen
`-`, `Der Piber` und `A` bis `FF`. Sie sind keine automatisch weggefallenen
Mitglieder.

Bei drei Faellen bestehen plausible manuelle Zuordnungskandidaten:

- ein zusaetzlicher zweiter Vorname im Export,
- ein abweichendes Geburtsdatum bei ansonsten gleichem Namen,
- ein im ePiber-Bestand fehlendes Geburtsdatum bei ansonsten gleichem Namen.

Diese Faelle zeigen, warum Name und Geburtsdatum nur fuer den ersten kontrollierten
Abgleich verwendet werden sollen. Eine unsichere Zuordnung darf nie automatisch
gespeichert werden.

### 5.1 Abweichungen bei den 138 eindeutig zugeordneten Personen

Nach feldbezogener Vergleichsnormalisierung wurden folgende Unterschiede
gefunden:

| Feld | Abweichungen |
|---|---:|
| `TelefonMobil` | 0 inhaltliche Abweichungen |
| `E-Mail` | 62 |
| `Adresse` | 9 |
| `Ort` | 2 |
| `PLZ` | 1 |
| `Geschlecht` | 1 |

Alle 138 Mobilnummern waren im Rohtext unterschiedlich formatiert, nach
Entfernung beziehungsweise Vereinheitlichung von `0043`, `+43`, Leerzeichen,
Schraegstrichen und anderen Trennzeichen aber inhaltlich identisch. Daraus folgt:

- Darstellung und Vergleich muessen getrennt behandelt werden.
- Eine reine Formatabweichung darf nicht als fachliche Datenaenderung erscheinen.
- Ob die gespeicherten Nummern selbst umgeschrieben werden, ist noch nicht
  entschieden.


## 6. Verpflichtende Klaerung der Normalisierungsrichtlinien

Vor Beginn der Implementierung der Normalisierungsseite muss ein eigener
fachlicher Abstimmungsschritt stattfinden. Die folgenden Regeln duerfen nicht
vom Entwickler stillschweigend festgelegt oder aus Beispieldaten abgeleitet
werden.

Die Abstimmung muss fuer jedes Feld mindestens unterscheiden:

- Normalisierung nur fuer den Vergleich,
- Normalisierung auch fuer den gespeicherten Zielwert,
- reine Warnung ohne automatische Korrektur,
- unzulaessiger Wert, der eine manuelle Entscheidung verlangt,
- erlaubter Leerwert,
- Bedeutung eines leeren Importfeldes,
- Umgang mit Gross-/Kleinschreibung und Unicode,
- Umgang mit mehreren fachlich moeglichen Zielwerten.

### 6.1 Namen

Zu klaeren:

- Fuehrende und nachgestellte Leerzeichen entfernen.
- Mehrfache Leerzeichen innerhalb des Namens vereinheitlichen oder erhalten.
- Bindestriche, Apostrophe, Klammern und Schraegstriche behandeln.
- Zweite Vornamen und Rufnamen behandeln.
- Umlaute und Ersatzschreibweisen wie `oe` gegen den entsprechenden Umlaut nur vergleichen oder
  tatsaechlich umschreiben.
- Gross-/Kleinschreibung fuer Vergleich und Speicherung festlegen.
- Unicode-Normalform festlegen, damit optisch gleiche Namen nicht technisch
  verschieden bleiben.

### 6.2 Telefonnummern

Zu klaeren:

- kanonisches Speicherformat, zum Beispiel E.164-artig mit `+43`,
- Umgang mit `0043`, `+43` und nationalem fuehrendem `0`,
- Leerzeichen, Bindestriche, Klammern und Schraegstriche,
- Nebenstellen,
- Plausibilitaetspruefung der Laenge,
- auslaendische Nummern,
- gemeinsame Familiennummern,
- Vergleichsnormalisierung ohne Speicherumschreibung,
- gewuenschtes Anzeigeformat im Frontend.

Bis zur Entscheidung gilt nur: `Telefon Privat` wird nicht importiert;
`Telefon Mobil` wird dem ePiber-Feld `TelefonMobil` gegenuebergestellt.

### 6.3 E-Mail-Adressen

Zu klaeren:

- Trim und kanonische Kleinschreibung,
- technische IDNA-/Punycode-Normalisierung der Domain,
- Umgang mit syntaktisch gueltigen, aber vermutlich falschen Domains,
- Umgang mit gemeinsam verwendeten Familienadressen,
- Verhalten bei neun im Export mehrfach verwendeten E-Mail-Adressen,
- Verhalten bei leerer Bestands- oder Importadresse,
- Prioritaet zwischen Kontaktadresse und Loginidentitaet.

Die aktuelle ePiber-Regel bleibt sicherheitsrelevant: Eine nichtleere gueltige
E-Mail-Adresse muss nach Kanonisierung eindeutig sein.

### 6.4 Postleitzahlen

Zu klaeren:

- PLZ als Text speichern, damit fuehrende Nullen moeglich bleiben,
- fuer Oesterreich genau vier Stellen verlangen oder nur warnen,
- auslaendische PLZ-Formate,
- Zusammenhang zwischen PLZ und Land,
- Umgang mit offensichtlich in das falsche Feld geratenen Orts- oder
  Laenderwerten,
- keine automatische Ortskorrektur allein aufgrund einer PLZ ohne bestaetigte
  Referenzdaten.

### 6.5 Ort

Zu klaeren:

- Schreibvarianten wie Kurzform und vollstaendige Gemeindebezeichnung,
- Punkte, Bindestriche und Schraegstriche,
- Gross-/Kleinschreibung,
- offensichtliche Tippfehler,
- Verknuepfung mit PLZ und Land,
- ob nur verglichen oder auf eine feste Ortsbezeichnung normalisiert wird.

### 6.6 Adresse

Zu klaeren:

- Abkuerzungen wie `Str.` gegen `Strasse`,
- Schreibweise von `Strasse` und `strasse`,
- Hausnummern, Stiegen, Topnummern und Schraegstriche,
- mehrfache Leerzeichen,
- Kommas und sonstige Trennzeichen,
- Gross-/Kleinschreibung,
- leere Adresse,
- keine automatische inhaltliche Korrektur ohne sichere Regel.

### 6.7 Land und Nationalitaet

Der aktuelle erste Importumfang nennt zwar noch kein eigenes ePiber-Landfeld,
der Export enthaelt aber `Land` und `Nationalitaet`. Vor der Implementierung ist
zu klaeren:

- ob `Land` kuenftig in ePiber gespeichert werden soll,
- ob es nur fuer PLZ- und Adressvalidierung benoetigt wird,
- erlaubte Laendercodes oder ausgeschriebene Namen,
- Normalisierung von `Oesterreich`, Umlautschreibweise und ISO-Codes,
- klare Trennung zwischen Wohnsitzland und Nationalitaet,
- Umgang mit leeren Laenderwerten.

Nationalitaet ist ohne eigene fachliche Anforderung nicht zu importieren.

### 6.8 Geburtsdatum

Zu klaeren:

- kanonisches Speicherformat,
- Vergleich von `TT.MM.JJJJ`, `YYYYMMDD` und historischem `YYMMDD`,
- eindeutige Jahrhundertbestimmung,
- Kalenderpruefung,
- zukuenftige oder unplausible Daten,
- erlaubte leere Werte bei technischen Personen,
- Datenschutz und Sichtbarkeit im Frontend.

### 6.9 Geschlecht

Zu klaeren:

- verbindliche Fachwerte in ePiber,
- Abbildung von extern `maennlich` und `weiblich` auf bestehend `1` und `2`,
- Bedeutung und Erhalt des technischen Sonderwerts `3`,
- Umgang mit leeren oder kuenftig weiteren Werten,
- Headerkorrektur `GeschlechtID` zu `Geschlecht`,
- keine automatische Umdeutung unbekannter Werte.

### 6.10 Aktivstatus und externer Mitgliedsstatus

Zu klaeren:

- ePiber: `1` aktiv, leer inaktiv,
- Normalisierung des aktuellen Werts `0` auf leer,
- Wirkung von `Aktivmitglied` und `Passivmitglied`,
- ob allein das Vorkommen im Export als vorhanden gilt,
- ob eine nur in ePiber vorhandene Person standardmaessig als
  Deaktivierungskandidat erscheint,
- Schutz technischer Personen,
- Schutz des letzten aktiven Admins,
- Schutz vor Selbstdeaktivierung des ausfuehrenden Admins,
- Sessionwiderruf nach bestaetigter Deaktivierung.

Bis zur Entscheidung hat der externe Status keine automatische Wirkung.

### 6.11 Leere Werte

Eine leere CSV-Zelle darf nicht pauschal als Loeschauftrag interpretiert werden.
Pro Feld muss festgelegt werden:

- leer ist ein gueltiger Zielwert,
- leer bedeutet unbekannt und soll den Bestand nicht ueberschreiben,
- leer ist ein Fehler,
- leer darf nur nach expliziter Zellenauswahl uebernommen werden.

### 6.12 Ergebnis der Abstimmung

Vor dem ersten Codeaenderungsauftrag ist aus den Entscheidungen eine
maschinennahe Regelmatrix zu erstellen. Vorgesehenes Format:

| Feld | Vergleichsnormalisierung | Speichernormalisierung | Leerregel | Validierung | Automatisch korrigierbar |
|---|---|---|---|---|---|
| Beispiel | trim/lower | trim | behalten | feste Regel | ja/nein |

Erst die freigegebene Regelmatrix ist Grundlage fuer Implementierung und Tests.


## 7. Seite 1: Daten normalisieren

### 7.1 Zugriff

- nur fuer angemeldete Benutzer mit Rolle `admin`,
- serverseitige Rollenpruefung ist autoritativ,
- Frontend-Gating dient nur der Darstellung,
- aktuelle Personendaten sind erforderlich,
- keine Last-known-good-Ausnahme fuer Schreiboperationen.

### 7.2 Admin-Leseprojektion

Die bestehende Projektion `memberDirectory` reicht nicht aus, weil sie nur aktive
Personen und nicht alle benoetigten Felder liefert.

Es wird eine neue admin-geschuetzte Projektion benoetigt. Sie darf nur die fuer
Normalisierung und spaeteren Abgleich freigegebenen Felder enthalten, zum
Beispiel:

- ID
- Nachname
- Vorname
- TelefonMobil
- E-Mail
- Ort
- Adresse
- PLZ
- GeburtsDatum
- Geschlecht
- Aktiv
- Role, nur soweit fuer Schutzpruefungen und Anzeige erforderlich
- spaeter ExternalID
- Tabellenrevision beziehungsweise ein geeigneter Konfliktnachweis

Nie projiziert werden:

- `PasswdHash`
- Passwort-Credentials
- Resetcodes oder Resetnachweise
- Sessiontokens oder Cookieinhalte
- Service-Account-Daten
- unbeteiligte CSV-Spalten

### 7.3 Analyseansicht

Die Seite zeigt ausschliesslich erkannte Auffaelligkeiten beziehungsweise bietet
einen Filter fuer alle Datensaetze.

Vorgesehene Filter:

- aktiv
- inaktiv
- technische Personen
- Personen mit Fehlern
- Personen ohne Fehler
- Fehlerart
- betroffenes Feld
- freie Suche

Vorgesehene Fehler- und Hinweiskategorien:

- fuehrender/nachgestellter Leerraum
- ungueltige E-Mail
- doppelte E-Mail
- nicht kanonischer Aktivwert
- unbekannter Geschlechtswert
- fehlendes Pflichtfeld
- ungueltiges Datumsformat
- auffaellige Telefonnummer
- auffaellige PLZ
- Schemaabweichung wie `GeschlechtID`

### 7.4 Auswahl und Vorschau

- Originalwert und vorgeschlagener Zielwert werden nebeneinander angezeigt.
- Keine Korrektur wird allein durch das Laden der Seite ausgefuehrt.
- Korrekturen werden einzeln auswaehlbar.
- Sichere gleichartige Korrekturen koennen nach Freigabe gesammelt ausgewaehlt
  werden.
- Unsichere Werte, insbesondere inhaltliche E-Mail-, Adress- oder
  Geschlechtskorrekturen, verlangen eine Einzelentscheidung.
- Vor dem Schreiben erscheint eine Gesamtvorschau.
- Die Vorschau nennt Person, Feld, Vorher-Wert und Nachher-Wert, ohne
  Sicherheitsfelder zu zeigen.
- Ein expliziter Bestaetigungsschritt startet die Writes.

### 7.5 Schreibvertrag

Die genaue Endpointform wird in der Implementierung festgelegt. Verbindliche
Eigenschaften:

- admin-only,
- geschlossener Requestvertrag,
- nur allowlist-basierte Felder,
- begrenzte Anzahl Aenderungen pro Request,
- `operationId` fuer Idempotenz,
- erwartete Tabellenrevision oder erwartete Vorher-Werte,
- erneuter aktueller Sheet-Read in der serialisierten `players`-Queue,
- stabile Zeilenaufloesung ueber ID und Developer Metadata,
- keine blind vertraute Zeilennummer aus dem Browser,
- vollstaendige serverseitige Validierung des Zielbestands,
- E-Mail-Eindeutigkeit nach Kanonisierung,
- Schutz mindestens eines aktiven Admins,
- Sessionwiderruf bei sicherheitsrelevanten Aenderungen,
- Cache-Refresh und `players`-Invalidierung nach Erfolg,
- Auditierung mit Adminprincipal, Zielperson, Vorher/Nachher und Ergebnis,
- keine Passwoerter, CSV-Rohdaten oder freien sensiblen Payloads im Auditlog.

### 7.6 Schemaaenderung Geschlecht

Die Headeraenderung `GeschlechtID` zu `Geschlecht` ist eine tabellenweite
Schemaaenderung und muss getrennt von normalen Zellkorrekturen behandelt werden.

Vor Ausfuehrung sind zu pruefen:

- Zielheader `Geschlecht` existiert noch nicht,
- Quellheader `GeschlechtID` existiert genau einmal,
- alle Zeilen bleiben spaltenstabil,
- Passwort- und sonstige Nachbarspalten werden nicht verschoben,
- Backend kann die Tabelle nach der Aenderung validieren und laden,
- Cache wird erst nach bestaetigtem Write aktualisiert,
- unklarer Writeausgang wird durch erneuten Read aufgeloest,
- Rollback ist aus dem vorherigen Sheet-Backup moeglich.


## 8. Testanforderungen fuer die Normalisierung

### 8.1 Backendtests

Mindestens zu testen:

- anonyme Benutzer werden abgewiesen,
- player und operator werden abgewiesen,
- admin darf lesen und schreiben,
- Projektion enthaelt keine Passwort- oder Resetfelder,
- unbekannte Requestfelder werden abgewiesen,
- nicht freigegebene Zielfelder werden abgewiesen,
- Trim-Regeln arbeiten exakt nach der freigegebenen Regelmatrix,
- leere Werte werden feldspezifisch behandelt,
- E-Mail-Kanonisierung und Eindeutigkeit werden erzwungen,
- bestehende ungueltige E-Mail wird sichtbar, aber nicht automatisch geraten,
- Rollen und Passwoerter bleiben bei allgemeinen Stammdatenwrites unveraendert,
- erwartete Vorher-Werte verhindern verlorene parallele Aenderungen,
- stabile Zeilenaufloesung funktioniert nach Sortieren/Verschieben,
- idempotente Wiederholung schreibt nicht doppelt,
- unklarer Google-Write wird kontrolliert bestaetigt oder als unbekannt gemeldet,
- Cache und Invalidierung werden nur nach sicherem Ergebnis aktualisiert,
- letzter aktiver Admin kann nicht versehentlich deaktiviert oder degradiert
  werden,
- Auditlog enthaelt keine Geheimnisse.

### 8.2 Browsertests

Mindestens zu testen:

- Admin-Gating der Seite,
- Lade-, Leer-, Fehler- und Erfolgszustaende,
- Filter fuer aktiv/inaktiv/technisch,
- Tastaturbedienbarkeit der Tabelle und Auswahl,
- responsive Bedienbarkeit auf Desktop und Mobilgeraet,
- Original- und Zielwert sind eindeutig unterscheidbar,
- Auswahl einzelner und mehrerer Korrekturen,
- Abbrechen veraendert keine Daten,
- Gesamtvorschau stimmt mit der Auswahl ueberein,
- Konfliktmeldung bei zwischenzeitlicher Aenderung,
- Teilerfolg beziehungsweise Fehler wird pro Person nachvollziehbar angezeigt,
- erneutes Laden zeigt den tatsaechlichen Sheetstand,
- keine sensiblen Werte in DOM, URL, Browserstorage oder Diagnoseereignissen.

### 8.3 Manuelle Abnahme

Nach automatisierten Tests sind auf PAJ mindestens zu pruefen:

- Login als Admin,
- Spielerverzeichnis,
- eigenes und fremdes Profil,
- Passwortfreigabe und Passwortverwaltung,
- offene und historische Matches,
- Rangliste,
- EntryList,
- Court-Zuweisung,
- Scoreboard-Namensaufloesung,
- Inaktivitaet technischer Personen,
- Backend-Readiness und Adminstatus,
- Audit- und Fehlerzaehler ohne Ausgabe sensibler Ereignisinhalte.


## 9. Rollout Phase 1 und 2

### 9.1 Phase 1: Implementierung und PAJ-Erprobung

1. Normalisierungsrichtlinien aus Abschnitt 6 fachlich eroertern.
2. Verbindliche Regelmatrix freigeben.
3. Technischen Detailplan fuer Endpoints, Seite und Tests festlegen.
4. Normalisierungsseite und Backendunterstuetzung implementieren.
5. Dokumentation und Tests aktualisieren.
6. Vollstaendige automatisierte Pruefungen ausfuehren.
7. PAJ-Sheet und betroffene PAJ-SQLite-Dateien sichern.
8. Normalisierungsanalyse auf PAJ im reinen Lesemodus ausfuehren.
9. Bericht mit den erwarteten Befunden vergleichen.
10. Ausgewaehlte Normalisierungen auf PAJ anwenden.
11. Manuelle Abnahme nach Abschnitt 8.3 durchfuehren.
12. Fehler korrigieren und PAJ-Abnahme wiederholen.

Es erfolgt kein automatischer Uebergang zu Live. Die erfolgreiche PAJ-Abnahme
muss ausdruecklich bestaetigt werden.

### 9.2 Phase 2: Normalisierung im Live-System

1. Freigabe fuer Live-Rollout einholen.
2. Code nach dem normalen Projektworkflow in Live bereitstellen.
3. Vor Datenwrites ein vollstaendiges Sheet-Backup erstellen.
4. Betroffene SQLite-Dateien konsistent sichern.
5. Normalisierungsanalyse zunaechst nur lesend ausfuehren.
6. Analysebericht fachlich kontrollieren.
7. Korrekturen in kleinen, nachvollziehbaren Gruppen auswaehlen.
8. Bestaetigte Korrekturen schreiben.
9. Nach jeder Gruppe den aktuellen Sheetstand und die Anwendung pruefen.
10. Abschliessende Funktionspruefung nach Abschnitt 8.3 durchfuehren.
11. Ergebnis, offene manuelle Datenfehler und Rolloutstatus dokumentieren.

### 9.3 Verbindlicher Stopppunkt

Nach erfolgreicher Live-Normalisierung endet der freigegebene Arbeitsumfang.

Insbesondere werden zu diesem Zeitpunkt noch nicht umgesetzt:

- CSV-Dateiauswahl,
- CSV-Parser in der Anwendung,
- ExternalID-Zuordnung,
- Anlage neuer Personen aus dem Export,
- Deaktivierung weggefallener Personen aus einem Exportvergleich,
- zellenweiser Bestands-/Importentscheid,
- Importwrites.

Die Fortsetzung mit Phase 3 benoetigt einen neuen ausdruecklichen Auftrag und
eine erneute Kontrolle der dann aktuellen Daten und Anforderungen.


## 10. Spaetere Phase 3: Import- und Abgleichseite

Dieser Abschnitt dokumentiert den bereits besprochenen Zielzustand, ist aber
nicht Bestandteil der zuerst freigegebenen Normalisierungsumsetzung.

### 10.1 Einlesen

- Admin waehlt eine CSV-Datei ueber ein lokales Dateifeld aus.
- Datei wird nicht hochgeladen.
- Dateigroesse und Zeilenzahl werden begrenzt.
- Kodierung wird erkannt beziehungsweise kontrolliert als Windows-1252 gelesen.
- CSV muss eine erwartete Kopfzeile und genau interpretierbare Spalten besitzen.
- Unbekannte Zusatzspalten werden nicht an das Backend weitergereicht.
- Finanz- und Verwaltungsfelder werden sofort verworfen.

### 10.2 Importprofil

Fuer das analysierte Exportformat wird ein festes Importprofil bevorzugt. Es
ordnet mindestens zu:

| Export | ePiber |
|---|---|
| `[Id]` | `ExternalID` |
| `Nachname` | `Nachname` |
| `Vorname` | `Vorname` |
| `Telefon Mobil` | `TelefonMobil` |
| `E-Mail` | `E-Mail` |
| `Ort` | `Ort` |
| `Adresse` | `Adresse` |
| `PLZ` | `PLZ` |
| `Geburtsdatum` | `GeburtsDatum` |
| `Geschlecht` | `Geschlecht` nach freigegebener Abbildung |

Ob `Land` spaeter hinzukommt, wird in der Normalisierungsdiskussion entschieden.

### 10.3 Zuordnungsreihenfolge

Nach bestaetigter Stabilitaet der externen ID:

1. Primaere Zuordnung ueber eindeutige `ExternalID`.
2. Fuer bestehende ePiber-Zeilen ohne `ExternalID` einmaliger Vorschlag ueber
   normalisierten Vorname, Nachname und Geburtsdatum.
3. Unsichere oder mehrdeutige Vorschlaege nur manuell verbinden.
4. Nach bestaetigter Erstzuordnung `ExternalID` an der bestehenden ePiber-Person
   speichern.
5. Kuenftige Namens- oder Geburtsdatumsunterschiede werden danach als
   Feldabweichung derselben Person erkannt.

Die Zuordnung ueber Name und Geburtsdatum ist nie ausreichend fuer einen
automatischen Write, wenn:

- mehrere Kandidaten existieren,
- ein Schluesselfeld fehlt,
- Name oder Geburtsdatum abweicht,
- eine ExternalID bereits einer anderen Person zugeordnet ist.

### 10.4 Differenzkategorien

| Kategorie | Bedeutung | moegliche Aktion |
|---|---|---|
| identisch | alle beruecksichtigten Werte gleich | standardmaessig ausblenden |
| geaendert | Person in beiden Bestaenden, mindestens ein Feld verschieden | zellenweise Zielwert waehlen |
| neu | nur im Import vorhanden | neue ePiber-Person anlegen |
| weggefallen | nur in ePiber vorhanden | nach Bestaetigung `Aktiv` leeren |
| unklar | keine sichere oder mehrdeutige Zuordnung | manuell zuordnen oder ignorieren |
| Konflikt | ungueltige oder nicht eindeutige Zielwerte | vor Write aufloesen |

Identische Datensaetze werden nicht in der Haupttabelle gezeigt. Ein Zaehler soll
angeben, wie viele identische Personen ausgeblendet wurden.

### 10.5 Tabellenansicht

Pro fachlichem Feld werden Bestands- und Importwert nebeneinander dargestellt,
zum Beispiel:

| Status | Nachname Bestand | Nachname Import | Vorname Bestand | Vorname Import | E-Mail Bestand | E-Mail Import |
|---|---|---|---|---|---|---|

Bedienregeln:

- nur unterschiedliche Werte hervorheben,
- durch Klick auf eine Zelle den gewuenschten Zielwert waehlen,
- Auswahl deutlich und tastaturbedienbar markieren,
- leeren Wert als echte Auswahl sichtbar darstellen,
- ganze Zeile auf Bestand setzen,
- ganze Zeile auf Import setzen,
- Zeile ignorieren,
- Filter fuer neu, weggefallen, geaendert, unklar und Konflikt,
- Filter fuer aktiv, inaktiv und technisch,
- Suchfeld,
- keine unsichere automatische Vorauswahl,
- Gesamtvorschau vor dem Schreiben.

### 10.6 Neue Personen

Bei einer bestaetigten Neuanlage:

- interne ID serverseitig als `max(ID)+1` vergeben,
- `ExternalID` eindeutig speichern,
- nur freigegebene Stammdaten uebernehmen,
- `Role` standardmaessig `player`, sofern nicht separat anders entschieden,
- Passwortfelder nicht aus dem Import befuellen,
- Passwortvergabe ueber den bestehenden sicheren Admin-/Erstvergabeprozess,
- Aktivstatus erst nach geklaerter Statusregel setzen,
- Google Developer Metadata fuer die neue Personenzeile anlegen,
- unklaren Append-Ausgang ueber ID und ExternalID bestaetigen,
- keine blinde Wiederholung eines unklaren Appends.

### 10.7 Weggefallene Personen

- keine Zeile loeschen,
- keine ID wiederverwenden,
- Querverweise unveraendert erhalten,
- nur nach expliziter Adminauswahl `Aktiv` leeren,
- technische Personen nicht automatisch behandeln,
- letzten aktiven Admin schuetzen,
- betroffene Sessions nach bestaetigter Deaktivierung widerrufen,
- Deaktivierung auditieren.

### 10.8 Feldschutz

Folgende Felder duerfen nicht durch den allgemeinen CSV-Abgleich ueberschrieben
werden:

- `ID` bestehender Personen
- `PasswdHash`
- `KennwortVergessen`
- Passwort- und Resetdaten
- `Role`, solange keine gesonderte fachliche Rollenregel beschlossen ist
- Google Developer Metadata als Browserwert
- interne Audit-, Session- oder Operationsdaten

### 10.9 Schreibstrategie

Empfohlen wird eine idempotente Operation pro Zielperson beziehungsweise eine
streng begrenzte Gruppe eindeutig zusammengehoeriger Aenderungen. Dadurch kann
ein Fehler bei einer Person sichtbar behandelt werden, ohne einen unkontrolliert
teilweise ausgefuehrten Gesamtimport zu erzeugen.

Jeder Write muss:

- den aktuellen Admin serverseitig pruefen,
- die aktuelle Personenzeile neu lesen,
- den im Vergleich verwendeten Vorher-Zustand pruefen,
- ExternalID- und E-Mail-Eindeutigkeit gegen den Gesamtbestand pruefen,
- alle unbekannten Felder ablehnen,
- nur explizit ausgewaehlte Feldwerte schreiben,
- den Ausgang bestaetigen,
- Cache und Topic aktualisieren,
- das Ergebnis ohne CSV-Rohdaten auditieren.


## 11. Datenschutz und lokale Exportdateien

Die analysierte Datei `export (4).csv` liegt derzeit unversioniert im
Repository-Root. Sie enthaelt neben den fuer ePiber benoetigten Kontaktdaten auch
Bank-, Zahlungs-, Beitrags- und Verwaltungsdaten.

Verbindliche Schutzregeln:

- CSV-Exporte niemals committen,
- keine Rohdatei in Tests oder Fixtures uebernehmen,
- fuer Tests ausschliesslich synthetische Daten verwenden,
- keine Rohzeilen, E-Mail-Adressen, Telefonnummern, Adressen, Bankdaten oder
  Namen in Logs schreiben,
- Fehlermeldungen auf Zeilennummer, Feld und kontrollierten Fehlercode begrenzen,
- Frontenddiagnose darf keine importierten Fachwerte transportieren,
- eine passende Ignore-Regel fuer lokale Mitgliedsexporte vor dem ersten
  fachlichen Commit aufnehmen,
- lokale Exportdateien nach Abschluss der Analyse kontrolliert ausserhalb des
  Repositorys archivieren oder loeschen.

Die Plan-Datei selbst enthaelt deshalb nur aggregierte Befunde, technische IDs
und technische Sondernamen, aber keine Kontakt- oder Finanzwerte aus dem Export.


## 12. Dokumentation bei Umsetzung

Vor beziehungsweise waehrend der jeweiligen Umsetzung sind nach Freigabe
mindestens folgende Dokumentationsziele zu pflegen:

- `Project/FACHKONZEPT.txt`
  - bestaetigtes Nutzungsszenario Mitgliederabgleich,
  - Adminrolle und Entscheidungsworkflow,
  - Deaktivieren statt Loeschen.
- neue Seitendokumentation fuer die Normalisierungsseite unter
  `Project/software/seiten/`.
- spaeter neue Seitendokumentation fuer die Importseite.
- `Project/software/ENDPOINTS.txt`
  - neue Admin-Lese- und Schreibvertraege.
- `Project/software/DATENBANK.txt`
  - normalisierte Personenfelder,
  - `ExternalID` und Eindeutigkeitsvertrag,
  - ID-Vergaberegel.
- `Project/software/ARCHITEKTUR.txt`
  - Browser-CSV-Verarbeitung,
  - Schreib-, Konflikt-, Audit- und Cachefluss.
- `Project/software/SOFTWARE-DOKU.txt`
  - Index der neuen Seiten.
- verpflichtendes Branch-Changelog nach dem Projektworkflow.

Die fachlichen Eintraege werden nicht allein aufgrund dieses Arbeitsplans als
kanonisch uebernommen. Vor ihrer Aufnahme ist der konkrete Inhalt mit dem
Auftraggeber abzustimmen.


## 13. Offene Entscheidungen

Vor Implementierung der Normalisierung:

- vollstaendige Regelmatrix aus Abschnitt 6,
- kanonisches Telefonnummernformat,
- PLZ-, Ort-, Adress- und Laenderregeln,
- kanonisches Geburtsdatumsformat,
- Geschlechtswerte und Sonderwert `3`,
- erlaubte Leerwerte je Feld,
- Umfang sicherer Sammelkorrekturen,
- genaue Behandlung technischer Personen in Warnungen und Filtern.

Vor Implementierung des Imports:

- Stabilitaet von `[Id]` ueber mehrere Exporte,
- genaue Wirkung von Aktivmitglied/Passivmitglied,
- Umgang mit mehrfach verwendeten E-Mail-Adressen,
- Verhalten bei leerem Importwert je Feld,
- Aufnahme eines Landfelds,
- Rollenzuweisung neuer Personen,
- genaue Darstellung und Bedienung der Zellenauswahl,
- maximale Dateigroesse und Datensatzanzahl,
- Wiederaufnahme nach unterbrochenem oder unklarem Write,
- fachliche Abnahme der ersten ExternalID-Zuordnung.


## 14. Zusammenfassung der Umsetzungsreihenfolge

```text
Normalisierungsregeln eroertern
  -> Regelmatrix freigeben
  -> Normalisierungsseite implementieren
  -> automatisiert testen
  -> PAJ sichern und normalisieren
  -> PAJ vollstaendig abnehmen
  -> Live sichern und normalisieren
  -> Live vollstaendig abnehmen
  -> VERBINDLICHER STOPP

Spaeterer neuer Auftrag:
  ExternalID-Stabilitaet bestaetigen
  -> Importregeln finalisieren
  -> Importseite implementieren
  -> PAJ testen
  -> kontrollierter weiterer Rollout
```

Dieser Ablauf darf nicht dadurch abgekuerzt werden, dass bereits waehrend der
Normalisierungsphase Importwrites oder automatische Massenkorrekturen eingebaut
werden.
