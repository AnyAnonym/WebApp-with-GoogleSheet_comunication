# Datenmatrix fuer den Mitgliederabgleich

Stand: 18.08.2026
Status: Phase 1 im Seitenbranch implementiert; noch nicht ausgerollt oder fachlich final abgenommen

Diese Datei beschreibt die Feldkorrespondenzen zwischen dem Google-Sheets-Tab
`Personen` auf PAJ und dem exemplarischen ClubDesk-Export `export (4).csv`.
Beide Quellen wurden am 18.08.2026 ausschliesslich lesend ausgewertet. Die Datei
enthaelt keine personenbezogenen Einzelwerte. Vor der Implementierung wird die
Matrix nochmals gemeinsam ausgegeben und freigegeben.

## 1. Verifizierte Quellstruktur

### 1.1 Google-Sheets-Tab `Personen`

Die Kopfzeile lautet in der tatsaechlich vorhandenen Reihenfolge und
Schreibweise:

```text
ID
CD-ID
Aktiv
Role
Nachname
Vorname
GeburtsDatum
GeschlechtID
TelefonMobil
E-Mail
Land
PLZ
Ort
Adresse
PTN
Avatar
passwdHash
kennwortVergessen
```

Festgestellte Besonderheiten:

- Das Sheet verwendet `GeschlechtID`, nicht `Geschlecht`.
- Die Sicherheitsfelder heissen exakt `passwdHash` und `kennwortVergessen`.
  Die Gross-/Kleinschreibung weicht damit von Teilen der bisherigen
  Dokumentation ab.
- Alle 177 `ID`-Werte sind numerisch und eindeutig. Der Wertebereich reicht
  aktuell von `1` bis `1032`.
- `CD-ID` ist in allen 177 Zeilen leer.

### 1.2 Exemplarischer ClubDesk-Export

Der Export enthaelt 171 Datensaetze und 59 Spalten. Fuer die Korrespondenz sind
folgende Header in ihrer exakten Schreibweise relevant:

```text
[Id]
[Gruppen]
Nachname
Vorname
Geburtsdatum
Geschlecht
Telefon Mobil
E-Mail
Land
PLZ
Ort
Adresse
```

`[Id]` steht im Export an Position 57 von 59. Alle 171 Werte sind befuellte,
eindeutige, siebenstellige Integerwerte. Der Export enthaelt ausserdem das Feld
`Status` mit 159 Werten `Aktivmitglied` und 12 Werten `Passivmitglied`. Dieses
Feld ist keine Korrespondenz fuer `Personen.Aktiv`: Nach der fachlichen Vorgabe
gilt jeder im Export enthaltene Datensatz als in ClubDesk aktiv gefuehrt.

Im Feld `[Gruppen]` enthalten 141 Datensaetze `A-Mitglieder`, 10 Datensaetze
`B-Mitglieder` und 20 Datensaetze keinen der beiden relevanten Werte. Im
exemplarischen Export enthaelt kein Datensatz beide Werte. Weitere Gruppenwerte
sind fuer ePiber nicht relevant und werden ignoriert.

## 2. Korrespondenzmatrix

| Google-Sheet | ClubDesk-Export | Korrespondenz und Zielregel |
|---|---|---|
| `ID` | keine | Interne, eindeutige ePiber-ID. Bestehende Werte bleiben unveraendert. Bei einer Neuanlage vergibt ausschliesslich das Backend `max(ID) + 1`; Luecken werden nicht aufgefuellt. |
| `CD-ID` | `[Id]` | Externe ClubDesk-ID als Querverweis. Die ClubDesk-ID ersetzt niemals `ID`. Beim ersten bestaetigten Abgleich wird sie an der zugeordneten Person gespeichert. Sie muss nichtleer, numerisch und im ePiber-Bestand eindeutig sein. |
| `Aktiv` | keine direkte Spalte | `1` bedeutet aktiv, leer bedeutet inaktiv. Jeder im vollstaendigen ClubDesk-Export enthaltene Datensatz gilt als aktiv und erhaelt nach bestaetigter Zuordnung `1`. Eine bisher aktive ePiber-Person, die im vollstaendigen Export fehlt, wird nach ausdruecklicher Auswahl durch Leeren des Feldes deaktiviert, niemals geloescht. Der ClubDesk-Wert `Status` steuert dies nicht. Technische Personen und der letzte aktive Admin bleiben geschuetzt. Bestehende `0`-Werte sind nicht kanonisch und werden nach Freigabe auf leer normalisiert. |
| `Role` | `[Gruppen]` | Zulaessige Werte sind `admin`, `operator`, `player`, `player A` und `player B`. Im ersten Normalisierungsschritt darf eine Spielerrolle `player` bleiben oder darauf normalisiert werden. `player`, `player A` und `player B` besitzen dieselben Zugriffsrechte. Erst der spaetere ClubDesk-Abgleich spezialisiert `A-Mitglieder` zu `player A` und `B-Mitglieder` zu `player B`. Andere Gruppenwerte werden ignoriert; bestehende Rollen `admin` und `operator` werden nicht ueberschrieben. Fehlt eine eindeutige A-/B-Zuordnung, bleibt der sichere Zwischenwert `player` erhalten und wird als noch zu spezifizieren ausgewiesen. |
| `Nachname` | `Nachname` | Direkte fachliche Korrespondenz. Abweichungen werden angezeigt und muessen ausgewaehlt werden. Eine weitergehende Schreibnormalisierung ausser der noch freizugebenden Leerraumregel ist nicht festgelegt. |
| `Vorname` | `Vorname` | Direkte fachliche Korrespondenz. Abweichungen werden angezeigt und muessen ausgewaehlt werden. Zweite Vornamen und Rufnamen werden nicht automatisch umgedeutet. |
| `GeburtsDatum` | `Geburtsdatum` | Direkte fachliche Korrespondenz. Kanonisches Speicherformat ist die im Sheet vorhandene Schreibweise `TT.MM.JJJJ`. Der aktuelle Sheet-Bestand verwendet dieses Format fuer alle 142 befuellten Werte; der Export fuer alle 171 Werte. |
| `GeschlechtID` | `Geschlecht` | Abbildung des ClubDesk-Strings auf die ePiber-ID: `männlich` -> `1`, `weiblich` -> `2`. Der ePiber-Wert `3` bedeutet `divers` und bleibt erhalten; der exemplarische Export enthaelt keinen korrespondierenden Wert. Unbekannte oder leere Importwerte werden nicht automatisch umgedeutet. Der Sheet-Header bleibt `GeschlechtID`. |
| `TelefonMobil` | `Telefon Mobil` | Direkte fachliche Korrespondenz. Speicherformat ist `00<Ländercode> <Netzvorwahl> <Rest>`. Erlaubt sind ausschliesslich Ziffern und Leerzeichen; nach Laendercode und Netzvorwahl steht jeweils genau ein Leerzeichen. Im restlichen Nummernteil sind weitere Leerzeichen beliebig erlaubt. Plus, Schraegstrich, Bindestrich, Punkt, Klammern und andere Sonderzeichen sind im Speicherwert unzulaessig. |
| `E-Mail` | `E-Mail` | Direkte fachliche Korrespondenz und zugleich Loginname. Bei der kontrollierten Erstzuordnung darf der ClubDesk-Wert ausgewaehlt werden. Bei spaeteren Abweichungen erfolgt niemals eine automatische Uebernahme: Die Oberflaeche muss auf die Aenderung des Loginnamens hinweisen und eine bewusste Einzelentscheidung verlangen. Nichtleere Adressen muessen nach Trim, Kleinschreibung und Domainkanonisierung syntaktisch gueltig und eindeutig sein. |
| `Land` | `Land` | Direkte Stringkorrespondenz. Die aktuell in beiden Quellen beobachtete Schreibweise lautet `Österreich`. Leere Werte werden nicht automatisch geraten. |
| `PLZ` | `PLZ` | Direkte Stringkorrespondenz; keine numerische Speicherung, damit fuehrende Nullen moeglich bleiben. Im Sheet sind alle 138 befuellten Werte vierstellig numerisch. Im Export sind 169 Werte vierstellig, zwei Werte weichen davon ab und verlangen eine manuelle Entscheidung. |
| `Ort` | `Ort` | Direkte Stringkorrespondenz. Abweichungen werden angezeigt; keine automatische inhaltliche Ortskorrektur. |
| `Adresse` | `Adresse` | Direkte Stringkorrespondenz. Abweichungen werden angezeigt; keine automatische inhaltliche Adresskorrektur. |
| `PTN` | keine | Kein Bestandteil des Mitgliederabgleichs. Bestehende Werte bleiben unveraendert; bei Neuanlagen bleibt das Feld leer. |
| `Avatar` | keine | Kein Bestandteil des Mitgliederabgleichs. Bestehende Werte bleiben unveraendert; bei Neuanlagen bleibt das Feld leer. |
| `passwdHash` | keine | Sicherheitsfeld. Darf weder gelesen/projiziert noch durch den Import gesetzt, geleert oder ueberschrieben werden. Bei Neuanlagen erfolgt die Passwortvergabe ausschliesslich ueber den bestehenden sicheren Prozess. |
| `kennwortVergessen` | keine | Sicherheitsfeld. Darf weder gelesen/projiziert noch durch den Import gesetzt, geleert oder ueberschrieben werden. |

## 3. Verifizierte Schreibweisen und Datenbefunde

| Feld | Google Sheet | ClubDesk-Export | Folgerung |
|---|---|---|---|
| `GeburtsDatum` / `Geburtsdatum` | 142-mal `TT.MM.JJJJ`, 35-mal leer | 171-mal `TT.MM.JJJJ` | Format kann unveraendert als `TT.MM.JJJJ` uebernommen werden. |
| `GeschlechtID` / `Geschlecht` | `1`: 104, `2`: 38, `3`: 1, leer: 34 | `männlich`: 123, `weiblich`: 48 | String-zu-ID-Abbildung gemaess Matrix; `3` wird nicht umgedeutet. |
| `Role` / `[Gruppen]` | aktuell `player`: 175, `admin`: 1, `operator`: 1 | 141 mit `A-Mitglieder`, 10 mit `B-Mitglieder`, 20 ohne beide Werte; keine Doppelzuordnung | `player` ist ein gueltiger Zwischenwert mit denselben Rechten wie `player A` und `player B`. Eindeutig zuordenbare Spieler werden spaeter spezialisiert; nicht eindeutig zuordenbare Spieler bleiben `player`. `admin` und `operator` werden nicht aus Gruppenwerten abgeleitet. |
| `TelefonMobil` / `Telefon Mobil` | 141 befuellt und nach der festgelegten Speicherregel gueltig; 36 leer | 171 befuellt, alle mit `+43` | Der Sheet-Bestand benoetigt keine Telefonnummernkorrektur. Das Exportformat ist fuer die Speicherung ungueltig, kann beim spaeteren Vergleich aber dieselbe Ziffernfolge repraesentieren. |
| `E-Mail` | 87 leer; 3 mit Rand-Leerraum; 11 mit Grossbuchstaben; 1 syntaktisch ungueltig; nach Kanonisierung keine Duplikate | keine leer; 6 mit Grossbuchstaben; keine syntaktisch ungueltig; 9 kanonische Mehrfachverwendungen | Loginwirkung und Eindeutigkeit verhindern eine automatische Massenuebernahme. Mehrfachverwendungen muessen vor einem Write aufgeloest werden. |
| `Land` | 176 leer, einmal `Österreich` | 119 leer, 52-mal `Österreich` | Vorhandene Werte stimmen in der Schreibweise ueberein. |
| `PLZ` | 138 vierstellige numerische Strings, 39 leer | 169 vierstellige numerische Strings, 2 sonstige | Abweichende Exportwerte nur nach manueller Entscheidung. |
| `Nachname` | 2 Werte mit Rand-Leerraum | 1 Wert mit Rand-Leerraum | Rand-Leerraum ist sichtbar zu normalisieren; die Sammelkorrektur muss vor Implementierung bestaetigt werden. |
| `Vorname` | 5 Werte mit Rand-Leerraum, 33 leer | 6 Werte mit Rand-Leerraum, keiner leer | Leere technische Bestandswerte sind nicht automatisch fehlerhaft. |
| `Ort` | 2 Werte mit Rand-Leerraum, 38 leer | 2 Werte mit Rand-Leerraum, keiner leer | Keine inhaltliche Korrektur allein aus Schreibvarianten ableiten. |
| `Adresse` | 1 Wert mit Rand-Leerraum, 41 leer | 1 Wert mit Rand-Leerraum, 1 leer | Ein leerer Importwert ist kein automatischer Loeschauftrag. |

### 3.1 Telefonnummernvergleich beim spaeteren Import

Speicherformat und Inhaltsvergleich werden getrennt bewertet. Fuer den Vergleich
wird ein fuehrendes `+` ausschliesslich gedanklich durch `00` ersetzt; danach
werden reine Formatzeichen entfernt und die verbleibende Ziffernfolge verglichen.
Das veraendert noch keinen Speicherwert und ergaenzt oder ersetzt keine Ziffer.

| Kategorie | Bedeutung | Behandlung |
|---|---|---|
| `PHONE_FORMAT_INVALID` | Ein ePiber-Speicherwert verletzt `00<Ländercode> <Netzvorwahl> <Rest>`. | Auf der Normalisierungsseite anzeigen und manuell korrigieren; keine Ziffern raten. |
| `PHONE_FORMAT_DIFFERENCE` | Nach Vergleichsnormalisierung sind alle Ziffern gleich, nur Praefixdarstellung, Leerzeichen oder Trennzeichen unterscheiden sich. | Als reine Formatabweichung anzeigen; kein fachlicher Telefonnummernunterschied. |
| `PHONE_CONTENT_DIFFERENCE` | Die bereinigten Ziffernfolgen unterscheiden sich mindestens an einer Stelle oder in der Laenge. | Schwerwiegende fachliche Abweichung; beide Werte anzeigen und nur nach manueller Entscheidung schreiben. |
| `PHONE_COMPARISON_UNCLEAR` | Eine Nummer besitzt keinen sicher erkennbaren internationalen Laendercode oder enthaelt nicht interpretierbare Zeichen. | Keine automatische Zuordnung oder Korrektur; manuelle Klaerung. |

Die Anwendung kann nicht feststellen, welche Ziffern objektiv richtig sind. Sie
kann nur feststellen, ob die vergleichbaren Ziffernfolgen beider Datenbestaende
gleich oder verschieden sind. Eine nationale Nummer wie `0664 ...` darf ohne
sicher bestaetigtes Land nicht automatisch zu `0043 664 ...` erweitert werden.

## 4. Vergleichs- und Schreibregeln

1. Zuerst wird eine Person ueber eine bereits gespeicherte eindeutige `CD-ID`
   zugeordnet.
2. Solange `CD-ID` noch leer ist, darf die Zuordnung ueber normalisierten
   Nachnamen, Vornamen und Geburtsdatum nur vorgeschlagen werden. Der erstmalige
   Link muss bestaetigt werden.
3. `ID`, `PTN`, `Avatar`, `passwdHash` und `kennwortVergessen` werden nie aus
   ClubDesk ueberschrieben. Fuer `Role` werden ausschliesslich die beiden
   festgelegten Korrespondenzen aus `[Gruppen]` ausgewertet; `admin` und
   `operator` bleiben unangetastet.
4. Ein Exportfeld ueberschreibt keinen Bestandswert allein deshalb, weil es
   anders ist. Jede fachliche Aenderung muss in der Vorschau sichtbar und
   ausgewaehlt sein.
5. Eine leere Exportzelle ist kein pauschaler Loeschauftrag. Sie darf nur bei
   einem dafuer freigegebenen Feld und nach ausdruecklicher Zellenauswahl
   uebernommen werden.
6. E-Mail-Aenderungen sind Login-Aenderungen und verlangen immer einen eigenen
   Warn- und Bestaetigungsschritt.
7. Deaktivierung erfolgt ausschliesslich durch Leeren von `Aktiv`; Personenzeilen
   und interne IDs werden nie geloescht oder wiederverwendet.
8. Alle Schreiboperationen bleiben bis zur Implementierungsfreigabe ausgesetzt.

## 5. Abweichungen vom bisherigen Arbeitsplan

Der bisherige Plan `MITGLIEDERABGLEICH.md` ging von einer neu einzufuehrenden
Spalte `ExternalID` und einer Headerkorrektur von `GeschlechtID` auf
`Geschlecht` aus. Nach der aktuellen fachlichen Erklaerung und dem verifizierten
Sheet-Iststand gelten fuer die weitere Planung stattdessen:

- Die vorhandene Spalte `CD-ID` nimmt die ClubDesk-Spalte `[Id]` auf.
- Die vorhandene Spalte und der Header `GeschlechtID` bleiben bestehen.
- Der Wert `3` ist fachlich als `divers` definiert.
- Die Rolle `player` bleibt als sicherer Zwischenzustand erhalten; `player A`
  und `player B` sind spaetere fachliche Spezialisierungen mit identischen
  Zugriffsrechten.
- `[Gruppen]` ordnet nur `A-Mitglieder` zu `player A` und `B-Mitglieder` zu
  `player B` zu; alle anderen Gruppenwerte werden ignoriert.

Diese Aussagen sind vor der Implementierung in die kanonische Fach- und
Softwaredokumentation zu uebernehmen, jedoch erst nach gesonderter Freigabe des
konkreten Dokumentationsumfangs.

## 6. Vorbereitete Aussagen fuer die kanonische Dokumentation

Die folgenden Aussagen sind nach fachlicher Freigabe in die genannten
kanonischen Dokumente zu uebernehmen. Dieser Abschnitt bereitet die Uebernahme
vor, aendert die kanonische Dokumentation aber noch nicht.

### `Project/FACHKONZEPT.txt`

- ePiber gleicht Personendaten mit einem vollstaendigen Export der aktuell in
  ClubDesk gefuehrten Mitglieder ab.
- Eine im Export enthaltene Person gilt fuer ePiber als aktiv. Fehlt eine zuvor
  zugeordnete Person im vollstaendigen Export, kann sie nach Adminbestaetigung
  durch Leeren von `Aktiv` deaktiviert werden; Person und interne ID werden nicht
  geloescht.
- Die zulaessigen Rollenwerte sind `admin`, `operator`, `player`, `player A` und
  `player B`. Die drei Spielerwerte besitzen dieselben Zugriffsrechte.
  ClubDesk `A-Mitglieder` korrespondiert mit `player A`, `B-Mitglieder` mit
  `player B`. Andere ClubDesk-Gruppen haben keine Rollenwirkung.
- Eine E-Mail-Adresse ist zugleich der Loginname. Ihre Aenderung muss deshalb
  bewusst bestaetigt und dem betroffenen Benutzer als Loginwechsel erkennbar
  gemacht werden.

### `Project/software/DATENBANK.txt`

- `Personen.ID` bleibt die interne, eindeutige ePiber-ID. Neue IDs werden
  serverseitig als `max(ID) + 1` vergeben und nie wiederverwendet.
- `Personen.CD-ID` speichert die eindeutige ClubDesk-Spalte `[Id]` als externen
  Querverweis; sie ersetzt `Personen.ID` nicht.
- `Personen.Aktiv` verwendet `1` fuer aktiv und leer fuer inaktiv.
- `Personen.Role` erlaubt `admin`, `operator`, `player`, `player A` und
  `player B`. `player` ist ein noch nicht nach A oder B spezifizierter
  Spielerstatus; alle drei Spielerwerte besitzen dieselben Zugriffsrechte.
- `Personen.GeschlechtID` verwendet `1` fuer maennlich, `2` fuer weiblich und
  `3` fuer divers. Der Header bleibt `GeschlechtID`.
- `Personen.GeburtsDatum` wird als `TT.MM.JJJJ`, `Personen.TelefonMobil` im
  Format `00<Ländercode> <Netzvorwahl> <Rest>` und `Personen.PLZ` als String
  gespeichert.
- `passwdHash` und `kennwortVergessen` sind geschuetzte Sicherheitsfelder und
  kein Bestandteil des Mitgliederimports.

### `Project/software/ARCHITEKTUR.txt`

- Die ClubDesk-Spalte `[Gruppen]` wird nur auf die exakten Werte
  `A-Mitglieder` und `B-Mitglieder` geprueft. Weitere Gruppen werden vor der
  Rollenbildung ignoriert.
- Bei vorhandener `CD-ID` erfolgt die primaere Zuordnung darueber. Die erstmalige
  Zuordnung ohne `CD-ID` ist nur ein zu bestaetigender Vorschlag aus Name und
  Geburtsdatum.
- Bestehende Rollen `admin` und `operator` duerfen durch den Gruppenabgleich
  nicht ueberschrieben werden. Fehlende oder widerspruechliche A-/B-Gruppen
  belassen die Person auf `player` und werden als noch zu spezifizieren
  ausgewiesen.
- E-Mail-Aenderungen sind sicherheitsrelevante Login-Aenderungen und duerfen
  weder automatisch noch ohne Eindeutigkeitspruefung geschrieben werden.
