#!/usr/bin/env bash
# net-setup-ap.sh — monte un point d'accès WiFi ChronoArchery (temporaire ou
# fixe/maître), avec hostapd + dnsmasq. Idempotent : peut être rappelé après
# net-teardown.sh sans laisser de résidu.
#
# Usage : net-setup-ap.sh --mode temp|master --ssid <ssid> --pass <mdp> [--iface <if>]
#
# NON TESTÉ SUR MATÉRIEL RÉEL — voir README, section « à vérifier avant de
# déployer » : toutes les cartes WiFi ne supportent pas le mode point
# d'accès, en particulier sur de vieux ordinateurs portables. Ce script
# vérifie ce support (check_ap_capable) et s'arrête proprement si absent,
# plutôt que d'échouer de façon confuse plus loin.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib-common.sh
source "$SCRIPT_DIR/lib-common.sh"

MODE=""
SSID=""
PASSPHRASE=""
IFACE="${CHRONO_WIFI_IFACE:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --ssid) SSID="$2"; shift 2 ;;
    --pass) PASSPHRASE="$2"; shift 2 ;;
    --iface) IFACE="$2"; shift 2 ;;
    *) die "option inconnue : $1" ;;
  esac
done

[[ "$MODE" == "temp" || "$MODE" == "master" ]] || die "--mode doit être 'temp' ou 'master' (reçu: '$MODE')"
[[ -n "$SSID" ]] || die "--ssid est requis"
[[ -n "$PASSPHRASE" && ${#PASSPHRASE} -ge 8 ]] || die "--pass est requis et doit faire au moins 8 caractères (WPA2)"
[[ -n "$IFACE" ]] || IFACE=$(detect_wifi_iface)

check_ap_capable "$IFACE"

if [[ "$MODE" == "temp" ]]; then
  AP_IP="10.99.0.1"
  DHCP_RANGE="10.99.0.50,10.99.0.150,12h"
else
  AP_IP="10.42.0.1"
  DHCP_RANGE="10.42.0.50,10.42.0.200,12h"
fi

log "démontage d'une éventuelle borne précédente avant de monter le mode '$MODE'"
"$SCRIPT_DIR/net-teardown.sh" || true

log "configuration de $IFACE en $AP_IP (mode $MODE, SSID $SSID)"
ip addr flush dev "$IFACE"
ip link set "$IFACE" down
ip addr add "${AP_IP}/24" dev "$IFACE"
ip link set "$IFACE" up

HOSTAPD_CONF="$CHRONO_RUN_DIR/hostapd.conf"
cat > "$HOSTAPD_CONF" <<EOF
interface=$IFACE
driver=nl80211
ssid=$SSID
hw_mode=g
channel=6
wmm_enabled=1
auth_algs=1
wpa=2
wpa_passphrase=$PASSPHRASE
wpa_key_mgmt=WPA-PSK
wpa_pairwise=CCMP
rsn_pairwise=CCMP
# Pas de "isolation" client-à-client : les écrans doivent pouvoir, à terme,
# se voir entre eux si besoin (diagnostics), seul le maître fait autorité.
ap_isolate=0
EOF

DNSMASQ_CONF="$CHRONO_RUN_DIR/dnsmasq.conf"
cat > "$DNSMASQ_CONF" <<EOF
interface=$IFACE
bind-interfaces
dhcp-range=$DHCP_RANGE
dhcp-option=3,$AP_IP
dhcp-option=6,$AP_IP
# Pas de résolution DNS vers l'extérieur : ce réseau n'a jamais accès à
# Internet, par conception (voir la note de cadrage du projet).
no-resolv
EOF

log "démarrage de hostapd"
hostapd -B -P "$CHRONO_RUN_DIR/hostapd.pid" "$HOSTAPD_CONF"

log "démarrage de dnsmasq"
dnsmasq --conf-file="$DNSMASQ_CONF" --pid-file="$CHRONO_RUN_DIR/dnsmasq.pid"

echo "$IFACE" > "$CHRONO_RUN_DIR/ap-iface"
log "borne '$MODE' opérationnelle sur $IFACE ($AP_IP), SSID $SSID"
