================================================================================
REGELWERK - Fachliche Regeln fuer Spielbetrieb und Organisation
================================================================================

Dieses Verzeichnis ist die verbindliche fachliche Detailquelle fuer bestaetigte
Regeln des Tennis-Spielbetriebs und der zugehoerigen organisatorischen Ablaeufe.
`Project/FACHKONZEPT.txt` bleibt das uebergeordnete Lastenheft fuer Produktvision,
Ziele, Benutzergruppen und Nutzungsszenarien.

Das Regelwerk beschreibt fachliches Sollverhalten unabhaengig davon, ob eine
Funktion bereits in ePiber umgesetzt ist. Das aktuelle Laufzeitverhalten wird in
den Softwaredokumenten und letztlich durch den Code bestimmt. Abweichungen
zwischen Sollregel und Implementierung werden benannt und nicht stillschweigend
aufgeloest.

Statusangaben:

  Bestaetigt
      Vom Auftraggeber ausdruecklich als verbindliche Regel festgelegt.

  Arbeitsannahme
      Aus dem aktuellen Betrieb oder der Implementierung abgeleitet, aber noch
      nicht als dauerhafte fachliche Regel bestaetigt.

  Offen
      Noch nicht entschieden oder nicht ausreichend beschrieben.

Verzeichnisstruktur:

  Spielbetrieb/
      Sportliche Regeln fuer Matches, Ranglisten, KO- und Gruppenbewerbe.

  Organisation/
      Rollen, Verantwortlichkeiten sowie organisatorische Regeln fuer Bewerbe,
      Personenpflege und Platz-/Anzeigebetrieb.

Nicht Bestandteil des Regelwerks sind konkrete Sheetspalten, APIs, Cookies,
Module, Datenbanken, Idempotenz, Logging, Audit, Observability, Deployment,
Serverkonfiguration, CSS oder konkrete UI-Komponenten. Diese technischen
Vertraege bleiben unter `Project/software/`, `Project/server-configs/` und in den
Seitendokumenten. Historische Dateien unter `Project/archive/` sind keine
Regelquelle.
