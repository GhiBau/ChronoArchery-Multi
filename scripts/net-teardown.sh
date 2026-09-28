#!/usr/bin/env bash
# net-teardown.sh — arrête proprement tout ce que net-setup-ap.sh ou
# net-join.sh a pu démarrer (hostapd, dnsmasq, wpa_supplicant, dhclient) et
# remet l'interface WiFi dans un état neutre. Toujours appelable sans risque,
# même si rien n'était démarré (idempotent).

set -uo pipefail  # pas de -e ici : on veut tenter CHAQUE arrêt même si un
                   # précédent échoue (processus déjà mort, fichier absent...).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib-common.sh
source "$SCRIPT_DIR/lib-common.sh"

kill_by_pidfile() {
  local pidfile="$1" name="$2"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      log "arrêt de $name (pid $pid)"
      kill "$pid" 2>/dev/null || true
      sleep 0.3
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
}

kill_by_pidfile "$CHRONO_RUN_DIR/hostapd.pid" "hostapd"
kill_by_pidfile "$CHRONO_RUN_DIR/dnsmasq.pid" "dnsmasq"
kill_by_pidfile "$CHRONO_RUN_DIR/wpa_supplicant.pid" "wpa_supplicant"
kill_by_pidfile "$CHRONO_RUN_DIR/dhclient.pid" "dhclient"

IFACE="${CHRONO_WIFI_IFACE:-}"
if [[ -z "$IFACE" ]]; then
  IFACE=$(cat "$CHRONO_RUN_DIR/ap-iface" 2>/dev/null || cat "$CHRONO_RUN_DIR/client-iface" 2>/dev/null || true)
fi

if [[ -n "$IFACE" ]] && ip link show "$IFACE" >/dev/null 2>&1; then
  log "remise à plat de l'interface $IFACE"
  ip addr flush dev "$IFACE" 2>/dev/null || true
fi

rm -f "$CHRONO_RUN_DIR/ap-iface" "$CHRONO_RUN_DIR/client-iface"
log "réseau ChronoArchery démonté"
exit 0
