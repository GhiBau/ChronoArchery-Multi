#!/usr/bin/env bash
# lib-common.sh — fonctions partagées par les scripts réseau ChronoArchery.
# À sourcer, jamais exécuté directement.

set -euo pipefail

CHRONO_RUN_DIR="${CHRONO_RUN_DIR:-/run/chronoarchery}"
CHRONO_LOG_TAG="chronoarchery-net"

log() { logger -t "$CHRONO_LOG_TAG" -- "$*" 2>/dev/null || echo "[$CHRONO_LOG_TAG] $*" >&2; }
die() { log "ERREUR: $*"; exit 1; }

mkdir -p "$CHRONO_RUN_DIR"

# Détecte la première interface WiFi disponible, sauf si CHRONO_WIFI_IFACE est
# déjà fixé dans l'environnement (utile pour forcer un choix sur une machine
# à plusieurs cartes WiFi, ou pour les tests).
detect_wifi_iface() {
  if [[ -n "${CHRONO_WIFI_IFACE:-}" ]]; then
    echo "$CHRONO_WIFI_IFACE"
    return 0
  fi
  local iface
  iface=$(iw dev 2>/dev/null | awk '$1=="Interface"{print $2; exit}')
  if [[ -z "$iface" ]]; then
    die "aucune interface WiFi détectée (essayez CHRONO_WIFI_IFACE=... pour forcer)"
  fi
  echo "$iface"
}

# Vérifie que l'interface donnée sait faire du mode point d'accès (AP).
# C'est le point d'incertitude matériel évoqué dans la conversation : toutes
# les cartes WiFi, notamment sur de vieux portables, ne le supportent pas.
check_ap_capable() {
  local iface="$1"
  if ! command -v iw >/dev/null 2>&1; then
    log "AVERTISSEMENT: la commande 'iw' est introuvable, impossible de vérifier le support du mode AP."
    return 0
  fi
  local phy
  phy=$(iw dev "$iface" info 2>/dev/null | awk '$1=="wiphy"{print $2; exit}')
  if [[ -z "$phy" ]]; then
    log "AVERTISSEMENT: impossible de déterminer le phy de $iface, vérification du mode AP ignorée."
    return 0
  fi
  if ! iw phy "phy${phy}" info 2>/dev/null | grep -q '\* AP$'; then
    die "la carte WiFi de $iface ne semble pas supporter le mode point d'accès (AP) — voir README, section « compatibilité WiFi »."
  fi
}
