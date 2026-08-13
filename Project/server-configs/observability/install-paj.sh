#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install-paj.sh muss als root ausgefuehrt werden" >&2
  exit 1
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SECRETS=/etc/epiber-observability/grafana.env

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
: "${EPIBER_ALERT_EMAIL:?EPIBER_ALERT_EMAIL fehlt}"
: "${GF_SMTP_HOST:?GF_SMTP_HOST fehlt}"
: "${GF_SMTP_USER:?GF_SMTP_USER fehlt}"
: "${GF_SMTP_PASSWORD:?GF_SMTP_PASSWORD fehlt}"
: "${GF_SMTP_FROM_ADDRESS:?GF_SMTP_FROM_ADDRESS fehlt}"

if [ "${#GF_SECURITY_ADMIN_PASSWORD}" -lt 16 ] || [ "${#GF_SECURITY_SECRET_KEY}" -lt 32 ]; then
  echo "Grafana-Passwort oder Secret-Key ist zu kurz" >&2
  exit 1
fi

case "$GF_SECURITY_ADMIN_PASSWORD $GF_SECURITY_SECRET_KEY $EPIBER_ALERT_EMAIL $GF_SMTP_HOST $GF_SMTP_USER $GF_SMTP_PASSWORD $GF_SMTP_FROM_ADDRESS" in
  *replace-with*|*.invalid*)
    echo "Grafana-Konfiguration enthaelt noch Vorlagenwerte" >&2
    exit 1
    ;;
esac

pacman -S --needed --noconfirm grafana grafana-alloy loki prometheus prometheus-node-exporter

for command in caddy grafana grafana-alloy loki prometheus prometheus-node-exporter promtool; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Fehlendes Arch-Paketwerkzeug: $command" >&2
    exit 1
  }
done

caddy adapt --config "$ROOT/../Caddyfile" >/dev/null
grafana-alloy validate "$ROOT/alloy"
loki -config.file="$ROOT/loki/loki.yaml" -verify-config=true
promtool check config "$ROOT/prometheus/prometheus.yml"

install -d -m 0755 /etc/grafana/provisioning/datasources /etc/grafana/provisioning/dashboards /etc/grafana/provisioning/alerting /etc/grafana/dashboards
install -d -m 0755 /etc/grafana-alloy /etc/loki /etc/prometheus/targets/enabled /etc/prometheus/targets/available /etc/systemd/system/grafana.service.d
install -m 0644 "$ROOT/alloy/config.alloy" /etc/grafana-alloy/config.alloy
install -m 0644 "$ROOT/loki/loki.yaml" /etc/loki/loki.yaml
install -m 0644 "$ROOT/prometheus/prometheus.yml" /etc/prometheus/prometheus.yml
install -m 0644 "$ROOT/prometheus/targets/enabled/paj.json" /etc/prometheus/targets/enabled/paj.json
install -m 0644 "$ROOT/prometheus/targets/available/pk.json" /etc/prometheus/targets/available/pk.json
install -m 0644 "$ROOT/prometheus/targets/available/live.json" /etc/prometheus/targets/available/live.json
install -m 0644 "$ROOT/prometheus/prometheus.env" /etc/conf.d/prometheus
install -m 0644 "$ROOT/node-exporter/node-exporter.env" /etc/conf.d/prometheus-node-exporter
install -o root -g grafana -m 0640 "$ROOT/grafana/grafana.ini" /etc/grafana.ini
install -m 0644 "$ROOT/grafana/provisioning/datasources/epiber.yml" /etc/grafana/provisioning/datasources/epiber.yml
install -m 0644 "$ROOT/grafana/provisioning/dashboards/epiber.yml" /etc/grafana/provisioning/dashboards/epiber.yml
install -m 0644 "$ROOT/grafana/provisioning/alerting/contact-points.yml" /etc/grafana/provisioning/alerting/contact-points.yml
install -m 0644 "$ROOT/grafana/provisioning/alerting/rules.yml" /etc/grafana/provisioning/alerting/rules.yml
install -m 0644 "$ROOT/grafana/dashboards/"*.json /etc/grafana/dashboards/
install -m 0644 "$ROOT/systemd/grafana.service.d/epiber-observability.conf" /etc/systemd/system/grafana.service.d/epiber-observability.conf

usermod -a -G caddy grafana-alloy
install -d -o caddy -g caddy -m 0750 /var/log/caddy
if [ ! -e /var/log/caddy/epiber-paj-access.json ]; then
  install -o caddy -g caddy -m 0640 /dev/null /var/log/caddy/epiber-paj-access.json
fi

promtool check config /etc/prometheus/prometheus.yml

systemctl daemon-reload
systemctl enable loki.service grafana-alloy.service prometheus.service prometheus-node-exporter.service grafana.service
systemctl restart loki.service grafana-alloy.service prometheus-node-exporter.service prometheus.service grafana.service

for url in http://127.0.0.1:3100/ready http://127.0.0.1:12345/-/ready http://127.0.0.1:9090/-/ready http://127.0.0.1:9100/metrics http://127.0.0.1:3000/api/health; do
  curl --fail --silent --show-error --max-time 10 "$url" >/dev/null
done

pacman -Q grafana grafana-alloy loki prometheus prometheus-node-exporter

echo "PAJ Observability installiert. Caddy-Vorlage separat kontrolliert installieren/reloaden."
echo "Grafana nur per SSH-Tunnel auf 127.0.0.1:3000 verwenden."
