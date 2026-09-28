#!/usr/bin/env bash
# kiosk-launch.sh — script client X exécuté au sein d'une session X11 déjà
# démarrée (voir systemd/chronoarchery-kiosk.service, qui l'invoque via
# `startx`). Déroulé :
#
#   1. Coupe la veille écran et le curseur de souris.
#   2. Lance un gestionnaire de fenêtres minimal (openbox).
#   3. Ouvre Chromium en plein écran sur la page locale de l'agent de
#      démarrage (compte à rebours + QR code) pendant que l'agent (agent.js)
#      tourne et décide du rôle du poste.
#   4. Une fois l'agent terminé (rôle décidé, réseau reconfiguré), relance
#      Chromium sur l'URL finale de l'application (écran ou maître).
#
# Ce script ne se termine normalement jamais tant que le poste tourne :
# systemd (Restart=always) le relance entièrement en cas de plantage de
# Chromium — on repart alors de zéro, y compris l'agent, ce qui est
# acceptable puisque l'agent applique de toute façon la dernière config
# connue en quelques secondes s'il n'y a pas eu de changement demandé.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
KIOSK_TARGET_PATH="${CHRONO_KIOSK_TARGET_PATH:-/run/chronoarchery/kiosk-url}"
AGENT_PORT="${CHRONO_AGENT_PORT:-8080}"
CHOOSER_URL="http://localhost:${AGENT_PORT}/?showqr=1"

log() { logger -t chronoarchery-kiosk -- "$*" 2>/dev/null || echo "[chronoarchery-kiosk] $*" >&2; }

# --- Vérification de mise à jour, tout au début, avant tout le reste ---
# Se fait ici et pas ailleurs : c'est le seul moment du cycle de vie du poste
# où (a) le réseau normal (Internet, s'il y en a) est encore en place, avant
# que l'agent ne le remplace par le réseau fermé ChronoArchery, et (b) rien
# n'est encore affiché à l'utilisateur, donc aucun risque d'interrompre quoi
# que ce soit. update-check.sh peut remplacer /opt/chronoarchery (dont CE
# script fait partie) : on se relance donc soi-même une seule fois après
# coup, pour être sûr d'exécuter la version à jour plutôt qu'un mélange des
# deux si le fichier a changé sous nos pieds pendant qu'on l'exécutait.
if [[ "${1:-}" != "--post-update" ]]; then
  bash "$SCRIPT_DIR/update-check.sh" || log "AVERTISSEMENT : la vérification de mise à jour a échoué (non bloquant)."
  exec "$0" --post-update
fi

# --- Confort écran : pas de veille, pas de curseur visible ---
xset s off -dpms 2>/dev/null || true
command -v unclutter >/dev/null 2>&1 && unclutter -idle 0.5 -root &

# --- Gestionnaire de fenêtres minimal ---
openbox &
sleep 1

CHROMIUM_BIN="$(command -v chromium || command -v chromium-browser || true)"
[[ -n "$CHROMIUM_BIN" ]] || { log "ERREUR : chromium introuvable dans le PATH"; exit 1; }

common_flags=(
  --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble
  --disable-translate --no-first-run --autoplay-policy=no-user-gesture-required
  --check-for-update-interval=31536000
)

launch_chromium() {
  local url="$1"
  log "ouverture de Chromium sur $url"
  "$CHROMIUM_BIN" "${common_flags[@]}" --app="$url" &
  echo $!
}

rm -f "$KIOSK_TARGET_PATH"

chromium_pid=$(launch_chromium "$CHOOSER_URL")

log "démarrage de l'agent de démarrage (choix du rôle)"
node "$INSTALL_DIR/node-agent/agent.js" &
agent_pid=$!

wait "$agent_pid"
agent_status=$?
if [[ $agent_status -ne 0 ]]; then
  log "AVERTISSEMENT : l'agent de démarrage s'est terminé en erreur (code $agent_status) — on reste sur l'écran de configuration."
fi

# Attend un court instant que le fichier d'URL finale soit bien écrit (marge
# de sécurité si l'agent vient tout juste de se terminer).
for _ in $(seq 1 10); do
  [[ -s "$KIOSK_TARGET_PATH" ]] && break
  sleep 0.3
done

if [[ -s "$KIOSK_TARGET_PATH" ]]; then
  final_url="$(cat "$KIOSK_TARGET_PATH")"
  log "bascule de Chromium vers l'URL finale : $final_url"
  kill "$chromium_pid" 2>/dev/null || true
  wait "$chromium_pid" 2>/dev/null || true
  sleep 1
  exec "$CHROMIUM_BIN" "${common_flags[@]}" --app="$final_url"
else
  log "aucune URL finale disponible — le poste reste sur l'écran de configuration."
  wait "$chromium_pid"
fi
