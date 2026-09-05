#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install-observability.sh muss als root ausgefuehrt werden" >&2
  exit 1
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SECRETS=/etc/epiber-observability/grafana.env
MESSAGING_SECRETS=/etc/epiber-observability/messaging-api.env
ENABLED_DEPLOYMENTS="live paj"
INFINITY_PLUGIN_ID=yesoreyeram-infinity-datasource
INFINITY_PLUGIN_VERSION=4.0.0

wait_for_url() {
  url=$1
  attempt=1
  while [ "$attempt" -le 60 ]; do
    if curl --fail --silent --show-error --max-time 10 "$url" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  echo "Dienst nicht rechtzeitig bereit: $url" >&2
  return 1
}

if [ ! -s "$SECRETS" ]; then
  echo "Fehlende lokale Grafana-Konfiguration: $SECRETS" >&2
  echo "Vorlage: $ROOT/grafana/grafana.env.example" >&2
  exit 1
fi

if [ "$(stat -c %U:%G:%a "$SECRETS")" != "root:root:600" ]; then
  echo "$SECRETS muss root:root und Modus 0600 besitzen" >&2
  exit 1
fi
if [ ! -s "$MESSAGING_SECRETS" ]; then
  echo "Fehlendes lokales Messaging-Credential: $MESSAGING_SECRETS" >&2
  echo "Vorlage: $ROOT/grafana/messaging-api.env.example" >&2
  exit 1
fi
if [ "$(stat -c %U:%G:%a "$MESSAGING_SECRETS")" != "root:root:600" ]; then
  echo "$MESSAGING_SECRETS muss root:root und Modus 0600 besitzen" >&2
  exit 1
fi

set -a
. "$SECRETS"
. "$MESSAGING_SECRETS"
set +a
: "${GF_SECURITY_ADMIN_PASSWORD:?GF_SECURITY_ADMIN_PASSWORD fehlt}"
: "${GF_SECURITY_SECRET_KEY:?GF_SECURITY_SECRET_KEY fehlt}"
: "${GF_SMTP_ENABLED:?GF_SMTP_ENABLED fehlt}"
: "${EPIBER_OBSERVABILITY_API_TOKEN:?EPIBER_OBSERVABILITY_API_TOKEN fehlt}"

if [ "${#GF_SECURITY_ADMIN_PASSWORD}" -lt 16 ] || [ "${#GF_SECURITY_SECRET_KEY}" -lt 32 ]; then
  echo "Grafana-Passwort oder Secret-Key ist zu kurz" >&2
  exit 1
fi
case "$EPIBER_OBSERVABILITY_API_TOKEN" in
  *[!A-Za-z0-9_-]*|'') echo "EPIBER_OBSERVABILITY_API_TOKEN muss Base64url-kodiert sein" >&2; exit 1 ;;
esac
if [ "${#EPIBER_OBSERVABILITY_API_TOKEN}" -lt 43 ]; then
  echo "EPIBER_OBSERVABILITY_API_TOKEN ist zu kurz" >&2
  exit 1
fi

case "$GF_SECURITY_ADMIN_PASSWORD $GF_SECURITY_SECRET_KEY" in
  *replace-with*)
    echo "Grafana-Konfiguration enthaelt noch Vorlagenwerte" >&2
    exit 1
    ;;
esac

if [ "$GF_SMTP_ENABLED" != "false" ]; then
  echo "GF_SMTP_ENABLED muss in dieser Ausbaustufe false sein" >&2
  exit 1
fi

for command in caddy getent gpasswd grafana grafana-alloy id loki node prometheus prometheus-node-exporter promtool runuser systemd-tmpfiles usermod; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Fehlendes Arch-Paketwerkzeug: $command" >&2
    exit 1
  }
done
for group in caddy grafana-alloy; do
  getent group "$group" >/dev/null || {
    echo "Fehlende lokale Gruppe: $group" >&2
    exit 1
  }
done

caddy adapt --config "$ROOT/../Caddyfile" >/dev/null
grafana-alloy validate "$ROOT/alloy"
loki -config.file="$ROOT/loki/loki.yaml" -verify-config=true
promtool check config "$ROOT/prometheus/prometheus.yml"

for deployment in $ENABLED_DEPLOYMENTS; do
  case "$deployment" in
    live) port=8080 ;;
    paj) port=8083 ;;
    *) echo "Unbekanntes aktives Deployment: $deployment" >&2; exit 1 ;;
  esac
  curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$port/metrics" >/dev/null || {
    echo "ePiber-Backend $deployment auf Port $port stellt /metrics noch nicht bereit" >&2
    exit 1
  }
done
BROKER=/srv/http/ePiber/piber/Backend/grafanaAuthBroker.js
if [ ! -r "$BROKER" ]; then
  echo "Der freigegebene Live-Stand enthaelt grafanaAuthBroker.js noch nicht" >&2
  exit 1
fi
if ! node -e 'const broker = require(process.argv[1]); const selected = broker.selectRealms?.("live,paj").map((realm) => realm.name).join(","); if (selected !== "live,paj") process.exit(1);' "$BROKER"; then
  echo "Der installierte Grafana-Auth-Broker unterstuetzt die fail-closed Live-/PAJ-Allowlist nicht" >&2
  exit 1
fi

install -d -m 0755 /etc/grafana/provisioning/datasources /etc/grafana/provisioning/dashboards /etc/grafana/provisioning/alerting /etc/grafana/dashboards/epiber
install -d -m 0755 /etc/grafana-alloy /etc/loki /etc/prometheus/targets/epiber /etc/systemd/system/grafana.service.d /etc/tmpfiles.d
install -d -o grafana -g grafana -m 0750 /var/lib/grafana/plugins
plugin_manifest="/var/lib/grafana/plugins/$INFINITY_PLUGIN_ID/plugin.json"
if [ -e "$plugin_manifest" ]; then
  installed_plugin=$(node -e 'const value=require(process.argv[1]); process.stdout.write(`${value.id}:${value.info.version}`)' "$plugin_manifest")
  if [ "$installed_plugin" != "$INFINITY_PLUGIN_ID:$INFINITY_PLUGIN_VERSION" ]; then
    echo "Infinity-Plugin weicht vom gepinnten Stand ab: $installed_plugin" >&2
    exit 1
  fi
else
  runuser -u grafana -- grafana cli --pluginsDir /var/lib/grafana/plugins plugins install "$INFINITY_PLUGIN_ID" "$INFINITY_PLUGIN_VERSION"
fi
installed_plugin=$(node -e 'const value=require(process.argv[1]); process.stdout.write(`${value.id}:${value.info.version}`)' "$plugin_manifest")
if [ "$installed_plugin" != "$INFINITY_PLUGIN_ID:$INFINITY_PLUGIN_VERSION" ]; then
  echo "Infinity-Plugin konnte nicht reproduzierbar installiert werden" >&2
  exit 1
fi
install -m 0644 "$ROOT/alloy/config.alloy" /etc/grafana-alloy/config.alloy
install -m 0644 "$ROOT/loki/loki.yaml" /etc/loki/loki.yaml
install -m 0644 "$ROOT/prometheus/prometheus.yml" /etc/prometheus/prometheus.yml
for deployment in $ENABLED_DEPLOYMENTS; do
  target="$ROOT/prometheus/targets/epiber/$deployment.json"
  if [ ! -r "$target" ]; then
    echo "Fehlende Prometheus-Zielvorlage: $target" >&2
    exit 1
  fi
  install -m 0644 "$target" "/etc/prometheus/targets/epiber/$deployment.json"
done
install -m 0644 "$ROOT/prometheus/prometheus.env" /etc/conf.d/prometheus
install -m 0644 "$ROOT/node-exporter/node-exporter.env" /etc/conf.d/prometheus-node-exporter
install -o root -g grafana -m 0640 "$ROOT/grafana/grafana.ini" /etc/grafana.ini
install -m 0644 "$ROOT/grafana/provisioning/datasources/epiber.yml" /etc/grafana/provisioning/datasources/epiber.yml
install -m 0644 "$ROOT/grafana/provisioning/datasources/loki.yml" /etc/grafana/provisioning/datasources/loki.yml
install -m 0644 "$ROOT/grafana/provisioning/dashboards/epiber.yml" /etc/grafana/provisioning/dashboards/epiber.yml
rm -f /etc/grafana/provisioning/alerting/contact-points.yml /etc/grafana/provisioning/datasources/epiber-operators-loki.yml
install -m 0644 "$ROOT/grafana/provisioning/alerting/rules.yml" /etc/grafana/provisioning/alerting/rules.yml
rm -f /etc/grafana/dashboards/epiber/*.json
install -m 0644 "$ROOT/grafana/dashboards/"*.json /etc/grafana/dashboards/epiber/
install -m 0644 "$ROOT/systemd/grafana.service.d/epiber-observability.conf" /etc/systemd/system/grafana.service.d/epiber-observability.conf
install -m 0644 "$ROOT/../systemd/epiber-grafana-auth.service" /etc/systemd/system/epiber-grafana-auth.service
install -m 0644 "$ROOT/../tmpfiles/epiber-observability.conf" /etc/tmpfiles.d/epiber-observability.conf

usermod -a -G caddy grafana
case " $(id -nG grafana) " in
  *" caddy "*) ;;
  *) echo "grafana muss Mitglied der Caddy-Gruppe sein" >&2; exit 1 ;;
esac
case " $(id -nG grafana-alloy) " in
  *" caddy "*) gpasswd -d grafana-alloy caddy >/dev/null ;;
esac
case " $(id -nG grafana-alloy) " in
  *" caddy "*) echo "grafana-alloy darf kein Mitglied der Caddy-Gruppe bleiben" >&2; exit 1 ;;
esac
systemd-tmpfiles --create /etc/tmpfiles.d/epiber-observability.conf
install -d -o caddy -g grafana-alloy -m 2750 /var/log/caddy
for deployment in $ENABLED_DEPLOYMENTS; do
  access_log="/var/log/caddy/epiber-$deployment-access.json"
  if [ ! -e "$access_log" ]; then
    install -o caddy -g grafana-alloy -m 0640 /dev/null "$access_log"
  else
    chown caddy:grafana-alloy "$access_log"
    chmod 0640 "$access_log"
  fi
done

promtool check config /etc/prometheus/prometheus.yml

systemctl daemon-reload
systemctl enable loki.service grafana-alloy.service prometheus.service prometheus-node-exporter.service grafana.service epiber-grafana-auth.service
systemctl restart loki.service grafana-alloy.service prometheus-node-exporter.service prometheus.service grafana.service epiber-grafana-auth.service

for url in http://127.0.0.1:3100/ready http://127.0.0.1:12345/-/ready http://127.0.0.1:9090/-/ready http://127.0.0.1:9100/metrics http://127.0.0.1:8085/live; do
  wait_for_url "$url"
done
report_to=$(($(date +%s) * 1000))
report_from=$((report_to - 86400000))
for port in 8080 8083; do
  curl --fail --silent --show-error --max-time 15 -H "Authorization: Bearer $EPIBER_OBSERVABILITY_API_TOKEN" "http://127.0.0.1:$port/internal/messaging-report?from=$report_from&to=$report_to" >/dev/null || {
    echo "Messaging-Reporting auf Port $port ist nicht bereit" >&2
    exit 1
  }
done
attempt=1
while [ "$attempt" -le 60 ]; do
  grafana_health=$(curl --fail --silent --show-error --max-time 10 --unix-socket /run/epiber-observability/grafana.sock http://localhost/grafana/api/health 2>/dev/null || true)
  case "$(printf '%s' "$grafana_health" | tr -d '[:space:]')" in
    *'"database":"ok"'*) break ;;
  esac
  attempt=$((attempt + 1))
  sleep 2
done
case "$(printf '%s' "$grafana_health" | tr -d '[:space:]')" in
  *'"database":"ok"'*) ;;
  *) echo "Grafana-Datenbank ist nicht rechtzeitig bereit" >&2; exit 1 ;;
esac

pacman -Q grafana grafana-alloy loki prometheus prometheus-node-exporter
echo "$INFINITY_PLUGIN_ID $INFINITY_PLUGIN_VERSION"

echo "Gemeinsame Live-/PAJ-Observability installiert. Caddy-Vorlage separat kontrolliert installieren/reloaden."
echo "Grafana nach dem Caddy-Reload als Live- oder PAJ-Admin unter https://epiber.at/grafana/ verwenden."
