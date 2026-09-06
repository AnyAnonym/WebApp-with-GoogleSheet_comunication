# Externe Scoreboard-Einheit

## Zweck und Abgrenzung

Die externe Scoreboard-Einheit erfasst die direkt am Tennisplatz eingestellten
Spielstaende und stellt sie ueber einen Scorer-Server bereit. ePiber steuert diese
Einheit nicht und verwendet auch nicht ihr Webportal. ePiber fragt ausschliesslich
die bereitgestellten JSON-Daten regelmaessig ab und verwendet die Ergebnisse fuer
den mobilen Liveticker und das digitale Scoreboard.

Die externe Scoreboard-Einheit und `Frontend/scoreboard.html` sind daher zwei
getrennte Komponenten:

- Die externe Einheit erfasst und uebertraegt den Spielstand.
- ePiber liest den bereitgestellten Stand und bereitet ihn fuer die eigenen
  Anzeigen auf.

## Komponenten

Die Anlage besteht aus:

- zwei physischen Anzeigetafeln an den Tennisplaetzen,
- einem eigenen Funkempfaenger im Clubheim auf der Veranda,
- dem externen Scorer-Server,
- einem vom Anbieter bereitgestellten, von ePiber aber nicht verwendeten
  Webportal,
- einer von ePiber regelmaessig abgefragten JSON-Datenquelle.

## Physische Anzeigetafeln

Auf jeder der beiden Anzeigetafeln befinden sich fuer Heim, oben angeordnet, drei
Drehfelder. Fuer Gast, unten angeordnet, sind ebenfalls drei Drehfelder vorhanden.
Jedes Drehfeld kann auf einen Wert von 0 bis 7 gestellt werden.

Sobald ein Drehfeld verstellt wird, sendet die Anzeigetafel die Aenderung ueber
ein eigenes Funkprotokoll an den zugehoerigen Receiver. Die genaue Bedeutung der
drei Felder und technische Einzelheiten des Funkprotokolls sind in diesem
Dokument noch nicht beschrieben.

Neben den sechs Drehwerten stellt das externe System je einen Punktewert fuer
Heim und Gast bereit. Diese Punkte koennen nicht an den physischen Drehfeldern
eingestellt werden. Sie werden ueber eine externe Ticker-App gepflegt, die mit
dem Scorer-Server kommuniziert, und von ePiber gemeinsam mit den Drehwerten aus
der JSON-Datenquelle gelesen.

Die Anzeigetafeln werden ueber einen dicht ausgefuehrten USB-C-Anschluss mit 5 V
versorgt. Ihre Stromversorgung ist permanent an das Stromnetz angeschlossen.

## Receiver

Der Receiver befindet sich fix montiert im Clubheim auf der Veranda. Er wird
ebenfalls ueber USB-C versorgt und ist dauerhaft an die Stromversorgung
angeschlossen.

Der Receiver hat ein kleines Touchdisplay. Nach dem Herstellen der
USB-C-Stromversorgung zeigt er ein Menue zur Auswahl eines WLANs an. Fuer das
Vereins-WLAN ist ein fixes Profil hinterlegt.

### Verbindungsaufbau

Der derzeit erforderliche Ablauf lautet:

1. Receiver mit Strom versorgen beziehungsweise nach einem Neustart das
   WLAN-Menue abwarten.
2. Das bereits hinterlegte Profil fuer das Vereins-WLAN am Touchdisplay
   anzeigen beziehungsweise auswaehlen.
3. Am Touchdisplay ausdruecklich `START` druecken.
4. Nach erfolgreicher WLAN-Verbindung baut der Receiver eine Verbindung zum
   externen Scorer-Server auf.

### Bekannte Probleme

- Der Receiver verbindet sich nach dem Einschalten derzeit nicht automatisch
  mit dem hinterlegten WLAN. Trotz des fixen Profils muss `START` manuell
  gedrueckt werden.
- Verliert der Receiver eine bestehende WLAN-Verbindung, stellt er sie derzeit
  nicht automatisch wieder her.
- Nach einem WLAN-Verlust ist deshalb ein manueller Eingriff am Touchdisplay des
  Receivers erforderlich.

Diese Punkte sind bekannte Einschraenkungen des externen Receivers und nicht der
ePiber-Anwendung.

## Externer Scorer-Server und Webportal

Sobald die WLAN-Verbindung steht, verbindet sich der Receiver mit dem externen
Scorer-Server und uebermittelt die von den Anzeigetafeln empfangenen
Spielstaende.

Der Anbieter stellt ein eigenes Webportal bereit. Dort koennten Live-Spielstaende
angesehen und Spiele bearbeitet werden. Dieses Portal wird im Vereinsbetrieb
nicht verwendet.

## Nutzung durch ePiber

ePiber greift auf eine vom externen System bereitgestellte JSON-Datenquelle zu.
Diese Datenquelle wird regelmaessig abgefragt. Die daraus gelesenen Spielstaende
werden fuer folgende eigene Ansichten verwendet:

- mobiler Liveticker fuer aktuelle Ergebnisse,
- digitales Scoreboard auf einem Fernseher am Tennisplatz.

ePiber bearbeitet die Spiele nicht ueber das externe Webportal. Die externe
Einheit dient fuer ePiber ausschliesslich als Quelle der erfassten
Live-Spielstaende.

## Matchtyp und Interpretation der Drehwerte

Die Google-Sheets-Tabelle `Matchtyp` wird von ePiber geladen. Bei einer
Court-Zuweisung liefert sie die Regeln, mit denen ePiber die vom externen
Scoreboard gelesenen Drehwerte fuer die Anzeige in `Frontend/scoreboard.html`
interpretiert. Die laufende Anzeige liest diese Tabelle nicht erneut, sondern
verwendet den bei der Zuweisung persistent gespeicherten Regelsnapshot.

Dieselben Matchtypdaten bilden auch die Grundlage der umgesetzten semantischen
Ergebnispruefung. Dafuer gelten alle sechs Felder strikt. Die Satzlaenge ist kein
einzelner Zahlenwert, sondern der tatsaechliche Zielbereich `0-4` oder `0-6`;
passend dazu gilt der Satz-Tie-Break bei `3-3` beziehungsweise `6-6`.

### Spalten der Tabelle Matchtyp

| Spalte | Werte und Bedeutung |
|---|---|
| `ID` | Eindeutige ganzzahlige ID eines Matchtyps. Der vorgesehene Wertebereich beginnt bei 1 und ist nach oben offen (`1` bis `x`). |
| `Bezeichnung` | Textuelle Bezeichnung des Matchtyps. |
| `Gewinnsaetze` | Anzahl der zum Matchgewinn erforderlichen Saetze. Wert `2` bedeutet Best-of-3, Wert `3` bedeutet Best-of-5. |
| `Satzlaenge` | Exakt `0-4` oder `0-6`; tatsaechlicher Zielbereich eines Satzes. |
| `Satztiebreak` | Exakt `3-3` passend zu `0-4` oder `6-6` passend zu `0-6`. |
| `Entscheidender Satz` | Form des erforderlichen Entscheidungssatzes, wenn noch kein Spieler beziehungsweise Team die notwendige Anzahl an Gewinnsaetzen erreicht hat. Die vorgesehenen Werte sind `vollstaendiger Satz`, `MT10` und `MT7`. |
| `NoAd` | Kennzeichen fuer die No-Ad-Regel. `N` bedeutet, dass nicht nach No-Ad gespielt wird; `J` bedeutet, dass nach No-Ad gespielt wird. |

### Varianten des entscheidenden Satzes

- `vollstaendiger Satz`: Es wird ein weiterer Satz mit der vollen Satzlaenge des
  Matchtyps gespielt.
- `MT10`: Der entscheidende Satz wird als Match-Tie-Break bis 10 gespielt.
- `MT7`: Der entscheidende Satz wird als Match-Tie-Break bis 7 gespielt.

Bei `MT7` und `MT10` werden die beiden digitalen Felder der dritten Satzspalte
mit tuerkisem statt blauem Hintergrund dargestellt. Dadurch ist erkennbar, dass
die dort angezeigten Werte einen Match-Tie-Break und keinen vollstaendigen Satz
darstellen. Die Satzfelder eins und zwei behalten ihren blauen Hintergrund.
Im Desktop- und Fernsehlayout bleibt die dritte Satzspalte bei einstelligen Werten
genauso breit wie die ersten beiden Satzspalten. Sobald bei Heim oder Gast ein
mindestens zweistelliger Wert angezeigt wird, wird die dritte Satzspalte fuer
beide Seiten gemeinsam verbreitert. Die Punktespalte bietet ausreichend Platz
fuer zweistellige Werte wie `40`. Die Spaltenbreiten des mobilen Layouts bleiben
unveraendert.

Im mobilen Layout befindet sich links oben ein dezenter Zurueck-Pfeil zum
Dashboard. Dadurch bleibt die Ruecknavigation auch auf Mobiltelefonen ohne
sichtbare Browser-Navigationsschaltflaechen moeglich. Auf Desktop- und
Fernsehanzeigen wird der Pfeil nicht eingeblendet.

Ein Entscheidungssatz wird beispielsweise benoetigt, wenn zwei Gewinnsaetze
erforderlich sind und beide Seiten jeweils einen Satz gewonnen haben.

### Zuordnung eines Matchtyps

Grundsaetzlich gilt fuer ein Match der Wert `MatchtypID Standard` des zugehoerigen
Bewerbs. Ist beim konkreten Match in `Matches1.MatchtypID` ein Wert eingetragen,
ueberschreibt dieser den Standard des Bewerbs.

Der so aufgeloeste Wert wird bei der Court-Zuweisung zusammen mit den zu diesem
Zeitpunkt wirksamen Anzeigeregeln im persistenten SQLite-Court-State gespeichert:

```text
displayRules: {
  schemaVersion: 1,
  source: "matchtyp",
  matchtypId,
  satztiebreak,
  entscheidenderSatz
}
```

`satztiebreak` ist der kanonisierte symmetrische numerische Ausloeser, zum
Beispiel `6-6`. `entscheidenderSatz` ist `vollstaendiger Satz`, `MT7` oder `MT10`.
Eine Individualzuweisung speichert `matchtypId: ""` und `displayRules: null`.

`matchtypId` und `displayRules` bleiben fuer die Dauer der Zuweisung unveraendert.
Spaetere Aenderungen der Zuordnung in `Matches1` oder `Bewerb` und spaetere
Aenderungen derselben `Matchtyp`-Zeile wirken deshalb erst nach einer erneuten
Court-Zuweisung. Die Scoreboard-Projektion verwendet keine Live-Matchtyp-Regeln.

Alte Court-Zustaende mit `matchtypId`, aber ohne `displayRules`, werden nach dem
ersten verwendbaren Matchtyp-Load ohne Score-Reset, ScoreLog-Write oder
Court-Event ergaenzt. Ist die ID, das Tabellenschema oder die Regel ungueltig,
bleibt der Zustand unveraendert und die Migration wird bei einer spaeteren
Tabellen-Recovery erneut versucht. Ein solcher nicht aufgeloester aktiver Court
macht `/ready` und `/health` bis zur Recovery, Neuzuweisung oder Deaktivierung
not-ready.

Noch aeltere Court-Zustaende ohne `matchtypId` bleiben lesbar, koennen aber keiner
Matchtyp-Zeile und damit keinem Regelsnapshot sicher zugeordnet werden. Sie werden
nicht automatisch migriert und muessen fuer die Matchtyp-Anzeigeprojektion
kontrolliert neu zugewiesen werden.

### Darstellung eines Satz-Tie-Breaks

Die dritte physische Drehspalte wird waehrend eines Tie-Breaks im ersten oder
zweiten Satz als Tie-Break-Zaehler verwendet. ePiber erkennt diesen Zustand,
wenn der aktuelle Stand des ersten oder zweiten Satzes dem Wert `Satztiebreak`
im persistierten `displayRules`-Snapshot entspricht.

In diesem Zustand gilt fuer die digitale Anzeige:

- Die Werte der dritten physischen Drehspalte werden als Punkte fuer Heim und
  Gast angezeigt.
- Die digitale Spalte fuer den dritten Satz zeigt fuer beide Seiten `0`.
- Die separat ueber die externe Ticker-App gelieferten Punktewerte werden
  voruebergehend durch die Tie-Break-Werte der dritten Drehspalte ersetzt.

Sobald keiner der ersten beiden Saetze mehr genau am festgelegten
Tie-Break-Stand steht, werden die drei Satzspalten und die externen Punkte wieder
unveraendert angezeigt. Ein Tie-Break oder Match-Tie-Break im echten dritten
Entscheidungssatz wird durch diese Anzeigeregel nicht umgedeutet.

Die externen Rohdaten und der im SQLite-ScoreLog gespeicherte Rohscore bleiben
unveraendert. Die Umdeutung findet
ausschliesslich in der fuer das digitale Scoreboard ausgegebenen Anzeigeprojektion
statt.

## Ergebnisvorschlag im gemeinsamen Profilmodal

Der gemeinsame Ergebnisdialog kann fuer Platz 1 oder Platz 2 einen editierbaren
Vorschlag laden. Ist dem ausgewaehlten Court aktuell exakt das betreffende Match
zugeordnet, werden dessen aktuelle sechs Satzwerte verwendet. Andernfalls sucht
ePiber den neuesten ScoreLog-Eintrag fuer die exakte Kombination aus Instanz,
Match-ID und Court. Der Court wird nicht in `Matches1` gespeichert; es gibt keinen
Fallback auf einen anderen Court oder ein nur aehnlich zugeordnetes Match.

Der dafuer verwendete SQLite-Index lautet
`score_log_match_latest(instance, match_id, court, sequence DESC)`. Bis zu drei
Satzpaare werden vorgeschlagen und abschliessende `0-0`-Saetze entfernt. Die
Quelle ist transparent als aktueller `court`, historisches `scoreLog` oder `none`
gekennzeichnet. Der Vorschlag ist keine automatische Ergebnisuebernahme: Er kann
vor dem Speichern bearbeitet werden und wird erst danach gegen den aktuellen
Matchtyp und Ergebnis-Fingerprint validiert.

Die acht aktuellen Scorewerte liegen nur im Prozessspeicher. Nach einem
Backendneustart wird der Stand eines laut SQLite aktiven Courts aus der externen
Quelle neu aufgebaut; deren erster gueltiger Stand wird sofort angezeigt, aber
nicht ins ScoreLog geschrieben. `scorelog.sqlite` protokolliert spaetere
Aenderungen mit Event-ID, Court-Folgenummer, Match-/Court-Kontext und UTC-Zeit,
wird aber niemals zur Rekonstruktion des Live-Stands gelesen. Der Insert erfolgt
vor Anzeige und Push; bei einem lokalen Persistenzfehler bleibt der bisherige
sichtbare Stand bis zum erfolgreichen Folgeversuch erhalten.

## Datenfluss

```text
Physische Anzeigetafel
        |
        | eigenes Funkprotokoll
        v
Receiver im Clubheim
        |
        | Vereins-WLAN / Internet
        v
Externer Scorer-Server
        |
        | regelmaessig abgefragte JSON-Daten
        v
ePiber
        |
        +--> mobiler Liveticker
        |
        +--> digitales Scoreboard am Tennisplatz
```

## Betriebliche Auswirkung

Damit ePiber aktuelle Spielstaende anzeigen kann, muessen alle folgenden
Voraussetzungen erfuellt sein:

- Die jeweilige Anzeigetafel ist mit Strom versorgt.
- Der Receiver ist mit Strom versorgt.
- Der Receiver ist mit dem Vereins-WLAN verbunden.
- Der Receiver hat eine Verbindung zum externen Scorer-Server aufgebaut.
- Die JSON-Datenquelle des externen Systems ist erreichbar und aktuell.
- Fuer eine neue Matchzuweisung sind die Tabelle `Matchtyp`, die aufgeloeste
  Matchtyp-Zuordnung und gueltige Anzeigeregeln verfuegbar. Die laufende Anzeige
  benoetigt danach keine aktuelle Matchtyp-Tabelle.
- Nach einer beabsichtigten Aenderung der Matchtyp-Zuordnung oder ihrer Regeln
  wird das Match erneut dem Court zugewiesen, damit der neue Regelsnapshot fuer
  diese Zuweisung uebernommen wird.

Nach einem Neustart oder WLAN-Verlust des Receivers muss vor Ort geprueft werden,
ob die WLAN-Verbindung besteht. Falls nicht, muss sie ueber das Touchdisplay und
die Schaltflaeche `START` manuell hergestellt werden.
