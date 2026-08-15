#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install-observability.sh muss als root ausgefuehrt werden" >&2
  exit 1
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SECRETS=/etc/epiber-observability/grafana.env

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

set -a
. "$SECRETS"
set +a
: "${GF_SECURITY_ADMIN_PASSWORD:?GF_SECURITY_ADMIN_PASSWORD fehlt}"
: "${GF_SECURITY_SECRET_KEY:?GF_SECURITY_SECRET_KEY fehlt}"
: "${GF_SMTP_ENABLED:?GF_SMTP_ENABLED fehlt}"

if [ "${#GF_SECURITY_ADMIN_PASSWORD}" -lt 16 ] || [ "${#GF_SECURITY_SECRET_KEY}" -lt 32 ]; then
  echo "Grafana-Passwort oder Secret-Key ist zu kurz" >&2
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

for command in caddy getent gpasswd grafana grafana-alloy id loki prometheus prometheus-node-exporter promtool systemd-tmpfiles usermod; do
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

for port in 8080 8083 8084; do
  curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$port/metrics" >/dev/null || {
    echo "ePiber-Backend auf Port $port stellt /metrics noch nicht bereit" >&2
    exit 1
  }
done
if [ ! -r /srv/http/ePiber/piber/Backend/grafanaAuthBroker.js ]; then
  echo "Der freigegebene Live-Stand enthaelt grafanaAuthBroker.js noch nicht" >&2
  exit 1
fi

install -d -m 0755 /etc/grafana/provisioning/datasources /etc/grafana/provisioning/dashboards /etc/grafana/provisioning/alerting /etc/grafana/dashboards/epiber
install -d -m 0755 /etc/grafana-alloy /etc/loki /etc/prometheus/targets/epiber /etc/systemd/system/grafana.service.d /etc/tmpfiles.d
install -d -o grafana -g grafana -m 0750 /var/lib/grafana/plugins
install -m 0644 "$ROOT/alloy/config.alloy" /etc/grafana-alloy/config.alloy
install -m 0644 "$ROOT/loki/loki.yaml" /etc/loki/loki.yaml
install -m 0644 "$ROOT/prometheus/prometheus.yml" /etc/prometheus/prometheus.yml
rm -f /etc/prometheus/targets/epiber/*.json
for target in "$ROOT"/prometheus/targets/epiber/*.json; do
  install -m 0644 "$target" "/etc/prometheus/targets/epiber/$(basename "$target")"
done
rm -f /etc/prometheus/targets/enabled/paj.json /etc/prometheus/targets/enabled/pk.json /etc/prometheus/targets/enabled/live.json
rm -f /etc/prometheus/targets/available/pk.json /etc/prometheus/targets/available/live.json
rmdir /etc/prometheus/targets/available 2>/dev/null || true
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
for deployment in live paj pk; do
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

echo "Gemeinsame ePiber-Observability installiert. Caddy-Vorlage separat kontrolliert installieren/reloaden."
echo "Grafana nach dem Caddy-Reload als Live-, PAJ- oder PK-Admin unter https://epiber.at/grafana/ verwenden."
