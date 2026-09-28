#!/usr/bin/env bash
# net-join.sh — rejoint le réseau WiFi du maître ChronoArchery en tant que
# client (utilisé par un poste "écran"). Utilise wpa_supplicant + dhclient
# directement plutôt que NetworkManager, pour ne pas dépendre de sa présence
# sur une installation Debian minimale.
#
# Usage : net-join.sh --ssid <ssid> --pass <mdp> [--iface <if>]
#
# NON TESTÉ SUR MATÉRIEL RÉEL — voir README.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib-common.sh
source "$SCRIPT_DIR/lib-common.sh"

SSID=""
PASSPHRASE=""
IFACE="${CHRONO_WIFI_IFACE:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssid) SSID="$2"; shift 2 ;;
    --pass) PASSPHRASE="$2"; shift 2 ;;
    --iface) IFACE="$2"; shift 2 ;;
    *) die "option inconnue : $1" ;;
  esac
done

[[ -n "$SSID" ]] || die "--ssid est requis"
[[ -n "$PASSPHRASE" ]] || die "--pass est requis"
[[ -n "$IFACE" ]] || IFACE=$(detect_wifi_iface)

log "démontage d'une éventuelle configuration réseau précédente"
"$SCRIPT_DIR/net-teardown.sh" || true

WPA_CONF="$CHRONO_RUN_DIR/wpa_supplicant.conf"
# wpa_passphrase évite d'écrire le mot de passe en clair dans le fichier de
# conf (il n'écrit que le PSK dérivé) — attendu disponible via le paquet
# wpasupplicant standard.
{
  echo "ctrl_interface=$CHRONO_RUN_DIR/wpa_ctrl"
  wpa_passphrase "$SSID" "$PASSPHRASE"
} > "$WPA_CONF"

ip link set "$IFACE" up

log "connexion WiFi à '$SSID' sur $IFACE"
wpa_supplicant -B -P "$CHRONO_RUN_DIR/wpa_supplicant.pid" \
  -i "$IFACE" -c "$WPA_CONF"

# Attend que l'association WiFi soit effective avant de lancer le DHCP —
# évite une demande DHCP envoyée avant que la carte soit réellement associée.
for _ in $(seq 1 20); do
  if iw dev "$IFACE" link 2>/dev/null | grep -q "^Connected to"; then
    break
  fi
  sleep 0.5
done

log "obtention d'une adresse IP par DHCP sur $IFACE"
dhclient -pf "$CHRONO_RUN_DIR/dhclient.pid" -lf "$CHRONO_RUN_DIR/dhclient.leases" "$IFACE"

echo "$IFACE" > "$CHRONO_RUN_DIR/client-iface"
log "connecté à '$SSID' sur $IFACE"
