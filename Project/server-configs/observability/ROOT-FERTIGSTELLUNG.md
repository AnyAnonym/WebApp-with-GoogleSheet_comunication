# PAJ Observability: Root-Fertigstellung

Dieses Runbook ist fuer die naechste OpenCode-Session mit Root-Rechten bestimmt.
Es aktiviert Observability ausschliesslich fuer PAJ. PK und Live bleiben als
deaktivierte Prometheus-Ziele vorbereitet und werden nicht veraendert.

## Grenzen

- Repository: `/srv/http/ePiber/paj`
- Erwarteter Branch: `4.3.0-paj-1`
- Erwarteter Commit und Paketstand: `4.3.0-paj-1-10`
- Kein Push, Merge oder PK-/Live-Rollout ohne neuen ausdruecklichen Auftrag.
- `Backend/.env`, Service-Account-Dateien und bestehende Geheimnisse nicht
  ausgeben oder versionieren.
- Grafana bleibt ausschliesslich ueber einen SSH-Tunnel erreichbar.
- `/metrics`, Loki, Prometheus, Alloy und Node Exporter bleiben auf Loopback.
- Bei einem fehlgeschlagenen Gate stoppen, Ursache beheben und nicht blind mit
  dem naechsten Abschnitt fortfahren.

## Noch benoetigte Eingaben

Vor dem Root-Lauf muessen diese Werte vom Betreiber bereitgestellt werden:

- Alarmempfaenger-E-Mail
- SMTP-Host inklusive Port
- SMTP-Benutzer
- SMTP-Passwort
- SMTP-Absenderadresse
- Name beziehungsweise SSH-Ziel fuer den spaeteren Grafana-Tunnel
- Verantwortliche und zweite pruefende Person fuer das Abnahmeprotokoll

Adminpasswort und Grafana-Secret-Key werden lokal mit `openssl rand` erzeugt.
Die Werte werden nicht im Repository gespeichert.

## 1. Release- und Host-Gate

```bash
cd /srv/http/ePiber/paj
git status --short --branch
git log -1 --format='%H%n%s'
node -p "require('./Backend/package.json').version"
node --version
npm --version
df -h / /var /srv/http/ePiber/paj
df -i / /var /srv/http/ePiber/paj
journalctl --disk-usage
```

Erwartet werden ein sauberer Arbeitsbaum, Commitbetreff
`4.3.0-paj-1-10 | Observability fuer PAJ integriert`, Paketversion
`4.3.0-paj-1-10`, Node.js 26.x und npm 12.0.1. Bei Abweichung stoppen.

Die lokale Paketdatenbank war vor dem Root-Lauf nicht synchronisiert. Ein
partielles Arch-Upgrade ist unzulaessig. Falls die Observability-Pakete nicht
bereits installiert sind, ist `pacman -Syu` ein hostweites Wartungsereignis und
muss vorab freigegeben sein. Danach Live und PAJ erneut pruefen.

## 2. Sicherungen

Vor den technischen Schritten ausserhalb dieses Terminals eine vollstaendige
Kopie des PAJ-Google-Spreadsheets erstellen und Backup-ID, Zeitpunkt und
verantwortliche Person dokumentieren.

```bash
cd /srv/http/ePiber/paj
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/var/backups/epiber-paj/$STAMP"
install -d -o root -g root -m 0700 "$BACKUP_DIR"
sqlite3 /var/lib/epiber-paj/state.sqlite ".backup '$BACKUP_DIR/state.sqlite'"
sqlite3 /var/lib/epiber-paj/scorelog.sqlite ".backup '$BACKUP_DIR/scorelog.sqlite'"
sqlite3 /var/lib/epiber-paj/audit.sqlite ".backup '$BACKUP_DIR/audit.sqlite'"
chmod 0600 "$BACKUP_DIR/"*.sqlite
install -o root -g root -m 0600 /etc/caddy/Caddyfile "$BACKUP_DIR/Caddyfile"
sha256sum "$BACKUP_DIR/"*
```

Den Wert von `BACKUP_DIR` im Abnahmeprotokoll festhalten.

## 3. Release-Build und PAJ-Backend

```bash
cd /srv/http/ePiber/paj/Backend
npm ci --omit=dev
npm run build
npm audit --omit=dev
cd /srv/http/ePiber/paj
systemctl restart epiber-paj.service
systemctl status epiber-paj.service --no-pager
journalctl -u epiber-paj.service --since "10 minutes ago" --no-pager
```

Auf Readiness warten und internen Endpoint pruefen:

```bash
for attempt in $(seq 1 60); do
  curl --fail --silent http://127.0.0.1:8083/ready && break
  sleep 2
done
curl --fail --silent http://127.0.0.1:8083/version
curl --fail --silent http://127.0.0.1:8083/live
curl --fail --silent http://127.0.0.1:8083/ready
curl --fail --silent http://127.0.0.1:8083/metrics >/dev/null
```

`/version` muss exakt `4.3.0-paj-1-10` liefern.

## 4. Arch-Pakete

Nur im freigegebenen hostweiten Wartungsfenster:

```bash
pacman -Syu --needed grafana grafana-alloy loki prometheus prometheus-node-exporter
pacman -Q grafana grafana-alloy loki prometheus prometheus-node-exporter
```

Danach sicherstellen, dass das Update die bestehenden Dienste nicht beschaedigt
hat:

```bash
systemctl is-active caddy.service epiber-piber.service epiber-paj.service
curl --fail --silent https://epiber.at/version
curl --fail --silent https://epiber.at/live
curl --fail --silent https://epiber.at:8081/version
curl --fail --silent https://epiber.at:8081/live
```

## 5. Lokale Grafana-Konfiguration

Zufallswerte erzeugen und sicher ausserhalb des Repositories verwahren:

```bash
openssl rand -hex 24
openssl rand -hex 32
```

```bash
install -d -o root -g root -m 0700 /etc/epiber-observability
install -o root -g root -m 0600 \
  /srv/http/ePiber/paj/Project/server-configs/observability/grafana/grafana.env.example \
  /etc/epiber-observability/grafana.env
editor /etc/epiber-observability/grafana.env
chown root:root /etc/epiber-observability/grafana.env
chmod 0600 /etc/epiber-observability/grafana.env
stat -c '%U:%G:%a %n' /etc/epiber-observability/grafana.env
```

Alle Vorlagenwerte ersetzen. Das Ergebnis muss `root:root:600` sein. Die Datei
nicht ausgeben und nicht nach Git kopieren.

## 6. Observability installieren

```bash
cd /srv/http/ePiber/paj
sh Project/server-configs/observability/install-paj.sh
systemctl status loki.service grafana-alloy.service prometheus.service \
  prometheus-node-exporter.service grafana.service --no-pager
systemd-analyze verify \
  /usr/lib/systemd/system/loki.service \
  /usr/lib/systemd/system/grafana-alloy.service \
  /usr/lib/systemd/system/prometheus.service \
  /usr/lib/systemd/system/prometheus-node-exporter.service \
  /usr/lib/systemd/system/grafana.service
id grafana-alloy
```

`grafana-alloy` muss Mitglied der Gruppe `caddy` sein.

## 7. Caddy aktivieren

```bash
cd /srv/http/ePiber/paj
caddy validate --config Project/server-configs/Caddyfile
install -o root -g root -m 0644 Project/server-configs/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy.service
systemctl status caddy.service --no-pager
journalctl -u caddy.service --since "10 minutes ago" --no-pager
stat -c '%U:%G:%a %n' /var/log/caddy/epiber-paj-access.json
```

Bei fehlgeschlagener Validierung die aktive Caddy-Konfiguration aus
`BACKUP_DIR` wiederherstellen und erneut validieren. Keinen fehlerhaften Reload
erzwingen.

## 8. Listener, Health und Targets

```bash
ss -ltnp | grep -E ':(3000|3100|9090|9100|12345)\b'
curl --fail --silent http://127.0.0.1:3100/ready
curl --fail --silent http://127.0.0.1:12345/-/ready
curl --fail --silent http://127.0.0.1:9090/-/ready
curl --fail --silent http://127.0.0.1:9100/metrics >/dev/null
curl --fail --silent http://127.0.0.1:3000/api/health
curl --fail --silent http://127.0.0.1:8083/metrics >/dev/null
curl --fail --silent http://127.0.0.1:9090/api/v1/targets | python -m json.tool
curl --fail --silent --get --data-urlencode 'query=up' \
  http://127.0.0.1:9090/api/v1/query | python -m json.tool
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  https://epiber.at:8081/metrics
```

Alle Observability-Listener muessen ausschliesslich an Loopback gebunden sein.
Das oeffentliche `/metrics` muss 404 liefern. Nur das PAJ-Backendziel ist aktiv;
PK und Live duerfen nicht in Prometheus erscheinen.

## 9. Datenschutz und HTTP-Korrelation

Nur synthetische Werte verwenden:

```bash
curl --silent --show-error \
  --header 'Authorization: Bearer DO-NOT-LOG' \
  --header 'Cookie: synthetic=DO-NOT-LOG' \
  'https://epiber.at:8081/version?token=DO-NOT-LOG'
if grep -F 'DO-NOT-LOG' /var/log/caddy/epiber-paj-access.json; then
  printf '%s\n' 'FEHLER: sensibler Wert wurde protokolliert'
  exit 1
fi
```

```bash
REQUEST_ID=$(
  curl --silent --show-error --dump-header - --output /dev/null \
    https://epiber.at:8081/version |
  awk 'tolower($1) == "x-request-id:" { gsub("\r", "", $2); print $2 }'
)
test -n "$REQUEST_ID"
printf '%s\n' "$REQUEST_ID"
grep -F "$REQUEST_ID" /var/log/caddy/epiber-paj-access.json
journalctl -u epiber-paj.service --since "5 minutes ago" --output cat |
  grep -F "$REQUEST_ID"
sleep 15
curl --fail --silent --get \
  --data-urlencode "query={deployment=\"paj\"} |= \"$REQUEST_ID\"" \
  --data-urlencode 'limit=20' \
  http://127.0.0.1:3100/loki/api/v1/query_range | python -m json.tool
```

Request-ID muss in Backend, Caddy und Loki auffindbar sein. Personen-, Session-,
Request-, IP- und Geraetewerte duerfen keine Loki- oder Prometheus-Labels sein.

## 10. Grafana und Betreiberorganisation

Auf dem Administratorrechner:

```bash
ssh -N -L 33000:127.0.0.1:3000 <SSH-BENUTZER>@epiber.at
```

Danach `http://127.0.0.1:33000` aufrufen und mit Benutzer `admin` sowie dem lokal
erzeugten Adminpasswort anmelden.

Manuell pruefen:

1. Vier PAJ-Dashboards sind vorhanden und liefern plausible Werte.
2. Prometheus-Datenquelle ist gesund.
3. Grafana-Alertregeln sind vorhanden.
4. Kontaktpunkt `epiber-operators` sendet eine Testmail.
5. Anonyme Anmeldung ist deaktiviert.
6. Eine getrennte Organisation `ePiber Operators` anlegen und nur autorisierte
   Betreiber hinzufuegen.
7. Die tatsaechliche Organisations-ID notieren.

Anschliessend auf dem Server `ORG_ID` auf die gepruefte ID setzen:

```bash
cd /srv/http/ePiber/paj
ORG_ID=2
sed "s/^    orgId: 2$/    orgId: ${ORG_ID}/" \
  Project/server-configs/observability/grafana/operators-loki.yml |
install -o root -g root -m 0644 /dev/stdin \
  /etc/grafana/provisioning/datasources/epiber-operators-loki.yml
systemctl restart grafana.service
curl --fail --silent http://127.0.0.1:3000/api/health
```

Danach negativ und positiv pruefen:

- Standardorganisation besitzt nur Prometheus und keinen Loki-Zugriff.
- Reine Dashboardbenutzer koennen Loki nicht abfragen.
- Betreiberorganisation besitzt Loki.
- Nur autorisierte Betreiber koennen personenbezogene JSON-Felder durchsuchen.

## 11. Alerts, Ausfall und Recovery

Vor kontrollierten Ausfaellen eine dokumentierte Grafana-Silence beziehungsweise
ein Wartungsfenster setzen.

Backend-Alarm und Recovery:

```bash
systemctl stop epiber-paj.service
sleep 180
systemctl start epiber-paj.service
for attempt in $(seq 1 60); do
  curl --fail --silent http://127.0.0.1:8083/ready && break
  sleep 2
done
```

Pruefen, dass genau der erwartete Alarm und danach die Resolve-Meldung ankommen.

Loki-Ausfall und Pipeline-Recovery:

```bash
systemctl stop loki.service
sleep 60
systemctl is-active epiber-paj.service
curl --fail --silent http://127.0.0.1:8083/live
curl --fail --silent http://127.0.0.1:8083/ready
systemctl start loki.service
curl --fail --silent http://127.0.0.1:3100/ready
```

Im Pipeline-Dashboard Alloy-Recovery, Sendefehler und Drops pruefen. Grafana-
Ausfall darf Datenerfassung nicht stoppen; Prometheus-Ausfall darf ePiber nicht
beeintraechtigen.

## 12. Verbindliche manuelle PAJ-Abnahme

Die vollstaendige Checkliste
`Project/server-configs/ROLLOUT-CHECKLIST.md` und Paket 9 aus
`Project/2do/LOGGING-OBSERVABILITY-RESTUMSETZUNGSPLAN.md` abarbeiten. Insbesondere
nicht ueberspringen:

- Adminstatus und `pendingMetadataIntents: 0`
- Browser-, Rollen-, WSS- und Frontenddiagnosepruefung
- normale und gezielte Diagnose inklusive Ablauf und 14-/7-Tage-Retention
- Sheet- und Court-Ausfall, Suppression und Recovery
- erwartete und doppelte Spitzenlast
- SIGTERM-Drain und sauberer Neustart
- Datenschutzpruefung der Loki-Labels, Grafana-Rollen und Exporte
- repraesentatives Dauerbetriebsfenster
- praktischer Rollback von Code, Caddy und Observability
- Vier-Augen-Abnahme ohne Geheimnisse oder personenbezogene Daten im Protokoll

PK und Live bleiben bis zur gesonderten Promotion unveraendert.

## 13. Abschlusszustand

```bash
cd /srv/http/ePiber/paj
git status --short --branch
git log -1 --oneline
curl --fail --silent http://127.0.0.1:8083/version
curl --fail --silent http://127.0.0.1:8083/live
curl --fail --silent http://127.0.0.1:8083/ready
curl --fail --silent http://127.0.0.1:9090/-/ready
curl --fail --silent http://127.0.0.1:3100/ready
curl --fail --silent http://127.0.0.1:3000/api/health
systemctl is-active epiber-paj.service caddy.service loki.service \
  grafana-alloy.service prometheus.service prometheus-node-exporter.service \
  grafana.service
```

Erwartet werden Commit und Version `4.3.0-paj-1-10`, ein sauberer Arbeitsbaum,
gruene Healthchecks und ausschliesslich aktive PAJ-Observability. Push, Merge und
PK-/Live-Aktivierung sind nicht Bestandteil dieses Runbooks.
