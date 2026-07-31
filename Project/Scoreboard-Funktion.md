# Externe Scoreboard-Einheit

Stand: v4.1.3, 2026-07-31

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

Die Google-Sheets-Tabelle `Matchtyp` wird von ePiber geladen. Sie liefert die
Regeln, mit denen ePiber die vom externen Scoreboard gelesenen Drehwerte fuer die
Anzeige in `Frontend/scoreboard.html` interpretiert.

In einem spaeteren Schritt sollen dieselben Regeln auch als Grundlage fuer eine
semantische Pruefung von Matchergebnissen dienen. Die Anzeigeinterpretation ist
damit der erste Anwendungsfall; die Ergebnispruefung ist ein geplanter, aber noch
nicht umgesetzter Folgeanwendungsfall.

### Spalten der Tabelle Matchtyp

| Spalte | Werte und Bedeutung |
|---|---|
| `ID` | Eindeutige ganzzahlige ID eines Matchtyps. Der vorgesehene Wertebereich beginnt bei 1 und ist nach oben offen (`1` bis `x`). |
| `Bezeichnung` | Textuelle Bezeichnung des Matchtyps. |
| `Gewinnsaetze` | Anzahl der zum Matchgewinn erforderlichen Saetze. Wert `2` bedeutet Best-of-3, Wert `3` bedeutet Best-of-5. |
| `Satzlaenge` | Ganzzahliger Wert von `0` bis `6`. Normalerweise wird ein Satz bis 6 gespielt; kurze Saetze koennen beispielsweise bis 4 gespielt werden. Die fachliche Bedeutung des Werts `0` ist noch nicht beschrieben. |
| `Satztiebreak` | Spielstand, bei dem im Satz ein Tie-Break gespielt wird. Aktuell sind `3-3` fuer einen kurzen Satz bis 4 und `6-6` fuer einen Satz bis 6 vorgesehen. |
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

Der so aufgeloeste Wert wird bei der Court-Zuweisung als `matchtypId` im
persistenten SQLite-Court-State gespeichert. Er bleibt fuer die Dauer dieser
Zuweisung unveraendert. Eine spaetere Aenderung der Matchtyp-Zuordnung in
`Matches1` oder `Bewerb` wirkt deshalb nicht auf ein bereits laufendes Match,
sondern erst nach einer erneuten Court-Zuweisung.

Court-Zuweisungen, die bereits vor Einfuehrung dieses Felds gespeichert wurden,
besitzen noch keine `matchtypId`. Sie muessen nach dem ersten Rollout einmal neu
zugewiesen werden, bevor die Matchtyp-abhaengige Tie-Break-Anzeige fuer sie gilt.

### Darstellung eines Satz-Tie-Breaks

Die dritte physische Drehspalte wird waehrend eines Tie-Breaks im ersten oder
zweiten Satz als Tie-Break-Zaehler verwendet. ePiber erkennt diesen Zustand,
wenn der aktuelle Stand des ersten oder zweiten Satzes dem Wert `Satztiebreak`
des aufgeloesten Matchtyps entspricht.

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

Die externen Rohdaten und das ScoreLog bleiben unveraendert. Die Umdeutung findet
ausschliesslich in der fuer das digitale Scoreboard ausgegebenen Anzeigeprojektion
statt.

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
- Die Tabelle `Matchtyp` und die Matchtyp-Zuordnung des laufenden Matches sind
  fuer die korrekte Interpretation eines Satz-Tie-Breaks verfuegbar.
- Nach einer beabsichtigten Aenderung der Matchtyp-Zuordnung wird das Match erneut
  dem Court zugewiesen, damit der neue Wert fuer diese Zuweisung uebernommen wird.

Nach einem Neustart oder WLAN-Verlust des Receivers muss vor Ort geprueft werden,
ob die WLAN-Verbindung besteht. Falls nicht, muss sie ueber das Touchdisplay und
die Schaltflaeche `START` manuell hergestellt werden.
