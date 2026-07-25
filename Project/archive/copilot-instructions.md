# ARCHIV — wird nicht mehr aktualisiert
# Aktueller Stand: siehe Project/VERSIONIERUNG.txt

# GitHub Copilot Instructions für ePiber

## Commit-Struktur nach Semantic Versioning

Bei der Erstellung von Commits sollte die folgende Struktur verwendet werden, basierend auf dem Umfang der Änderungen:

### MAJOR - Breaking Changes
- Signifikante Änderungen, die die Kompatibilität brechen
- Datenbankschema-Refactorings
- Änderungen an APIs oder Funktionssignaturen
- Beispiele:
  - `breaking(database): refactor tournament schema`
  - `breaking(firestore): change collection structure`

### MINOR - Features
- Neue Features oder Funktionalität
- Neue Funktionen hinzufügen
- Erwerbungen von bestehenden Features
- Beispiele:
  - `feat(matches): add new tournament feature`
  - `feat(navigator): implement ranking calculation`
  - `feat(entryList): add player filtering options`

### PATCH - Fixes & Small Improvements
- Bugfixes
- Performance-Verbesserungen
- Code-Cleanup und Refactoring (nicht breaking)
- Dokumentation
- Beispiele:
  - `fix(navigator): resolve state management bug`
  - `fix(matches): correct score calculation`
  - `fix(preMatches): handle null values properly`
  - `docs(README): update deployment instructions`

## Commit-Message Format

**WICHTIG: Die Versionsnummer MUSS am Anfang stehen!**

```
<VERSION> <type>(<scope>): <description>

[optional body]

[optional footer]
```

**Beispiele (Versionsnummer führend):**
- `1.20.1 fix(navigator): resolve state management bug`
- `1.21.0 feat(matches): add new tournament feature`
- `1.21.1 docs(config): add copilot commit guidelines`
- `2.0.0 breaking(database): refactor tournament schema`

### Types
- `feat` - Neue Feature (MINOR)
- `fix` - Bugfix (PATCH)
- `docs` - Dokumentation (PATCH)
- `style` - Code-Style, Formatierung (PATCH)
- `refactor` - Code-Refactoring ohne neue Features (PATCH)
- `perf` - Performance-Verbesserungen (PATCH)
- `test` - Tests hinzufügen/anpassen (PATCH)
- `breaking` - Breaking Changes (MAJOR)

### Scopes für ePiber
- `matches` - Match-Management
- `navigator` - Navigator/Scoreboard
- `preMatches` - Pre-Match-Verwaltung
- `entryList` - Anmeldungsliste
- `ranking` - Ranglisten-Funktionalität
- `functions` - Backend/Firebase Functions
- `firestore` - Datenbank/Firestore
- `ui` - Frontend/UI Änderungen
- `config` - Konfiguration
- `database` - Datenbankschema

## Verwendung mit Gitlens

Verwende **Gitlens Commit Composer** um deine Commits zu organisieren:
- Strukturiere größere Änderungen in mehrere, semantisch sinnvolle Commits
- Nutze die Commit-Vorschläge basierend auf deinen Änderungen

## Versionierung - WICHTIG für Copilot

Die Versionsnummern folgen **Semantic Versioning**: `MAJOR.MINOR.PATCH`

**Regeln für Versions-Updates basierend auf Commit-Types:**
1. **MAJOR** erhöhen wenn: `breaking()` oder massive strukturelle Änderungen
   - Beispiel: `1.20.0` → `2.0.0`
2. **MINOR** erhöhen wenn: `feat()` oder neue Features hinzugefügt werden
   - Beispiel: `1.20.0` → `1.21.0`
3. **PATCH** erhöhen wenn: `fix()`, `docs()`, `refactor()`, `perf()`, `test()`, `style()`
   - Beispiel: `1.20.0` → `1.20.1`

**Beispiel-Progression:**
- `1.0.0` - Initial Release
- `1.1.0` - Neue Features hinzufügt → MINOR
- `1.1.1` - Bugfix → PATCH
- `1.2.0` - Weitere Features → MINOR
- `2.0.0` - Breaking Changes → MAJOR

**ANWEISUNG FÜR COPILOT**: 
Nutze diese Versioning-Regeln, um in deinen Commit-Summaries oder Release-Notes zu dokumentieren, wie sich die Versionsnummer ändert. Mache die Versions-Auswirkung bei jedem Commit bewusst!

---

## 📝 Wichtige Hinweise

**Aktuelle Version**: `1.20.0`
- **Commit**: `4030e79fcad3e53aa905e47238a611b516c559d0` (gepusht)
- Letztes Release vor dieser Version: `1.19.3` (von palf80)
- Version `1.20.0` wurde erstellt, da neue Features hinzugefügt wurden (MINOR-Update)
- **⚠️ Alle neuen Commits sollten ab diesem Punkt mit der unten definierten Struktur fortgesetzt werden**

**Verwendung in VS Code** (Empfohlen):
- Diese Richtlinien werden von GitHub Copilot in VS Code automatisch berücksichtigt
- Nutze **Gitlens Commit Composer** (VS Code Extension) für intelligente Commit-Strukturierung
- Die Anleitung hilft dir, semantisch korrekte Commits zu erstellen

**In GitHub Desktop**:
- Diese Richtlinien werden derzeit NICHT automatisch berücksichtigt
- Nutze VS Code für Commits mit Copilot-Unterstützung, dann pushe via GitHub Desktop
- Oder schreibe die Commit-Messages manuell nach diesem Schema

**Ziel**: Eine klare, versionierbare Projekt-Historie mit automatischem Release-Management basierend auf Commit-Types.

**Wichtig**: bitte die Major.Minor.Build struktur beibehalten, um die Versionskontrolle und Release-Management zu vereinfachen.
