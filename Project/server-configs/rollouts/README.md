# ePiber Freigabeprotokolle

Dieses Verzeichnis enthaelt versionierte, datensparsame Nachweise abgeschlossener
Produktionsfreigaben. Die Dateien ergaenzen die Soll- und Ablaufdokumentation,
sind aber weder ein weiteres Changelog noch ein Ersatz fuer technische Backups.

## Benennung und Inhalt

Jede abgeschlossene Freigabe erhaelt genau eine Datei `<version>.md`. Sie darf
die konkrete Releaseversion, Commit-SHA, Systeme, Migrationssummen, bestaetigte
Backupklassen, Abnahmeergebnisse, bekannte nicht personenbezogene Abweichungen
und den Freigabestatus enthalten.

Nicht aufgenommen werden Namen, E-Mail-Adressen, personenbezogene IP-Adressen,
Personen-, Session-, Client-, Request-, Support- oder Geraetekennungen, Cookies,
Tokens, Passwortwerte und -Hashes, private Schluessel, lokale Geheimniswerte,
Logauszuege oder Inhalte von Google Sheets und SQLite. Lokale Backup-Pruefsummen
bleiben beim geschuetzten Backup und werden nicht versioniert.

## Abgrenzung

- `Project/ChangeLogs/ChangeLog-main.txt` beschreibt Aenderungen zwischen
  Main-Versionen; ein Freigabeprotokoll beschreibt die konkrete Betriebsabnahme.
- `Project/server-configs/ROLLOUT-CHECKLIST.md` bleibt das verbindliche Gate und
  die Vorlage fuer kuenftige Freigaben.
- Hostbezogene Backups liegen ausschliesslich in geschuetzten Betriebsverzeichnissen
  und nie in Git. Ein lokaler Pfad im Protokoll ist keine Disaster-Recovery-Zusage.
- Nachtraegliche Korrekturen werden als nachvollziehbare neue Dokumentationsaenderung
  versioniert; bereits bestaetigte Ergebnisse werden nicht stillschweigend ersetzt.
