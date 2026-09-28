#!/usr/bin/env bash
# update-check.sh — vérifie/applique une mise à jour de l'application, mais
# UNIQUEMENT à ce moment précis du démarrage : avant que l'agent ne
# reconfigure le réseau (donc avant de perdre l'accès à Internet le cas
# échéant) et avant qu'un écran ne soit affiché à l'utilisateur. Jamais
# rappelé en cours de séance — voir la conversation de conception : aucune
# mise à jour ne doit jamais interrompre un tir en cours.
#
# Best-effort : toute impossibilité (pas de réseau, dépôt injoignable,
# fichier corrompu) fait sortir ce script en succès (code 0) sans rien
# changer — jamais bloquant pour le démarrage du poste.

set -uo pipefail
log() { logger -t chronoarchery-update -- "$*" 2>/dev/null || echo "[chronoarchery-update] $*" >&2; }

INSTALL_LINK="${CHRONO_INSTALL_LINK:-/opt/chronoarchery}"
RELEASES_DIR="${CHRONO_RELEASES_DIR:-/opt/chronoarchery-releases}"
SOURCE_CONF="${CHRONO_UPDATE_SOURCE_CONF:-/etc/chronoarchery/update-source.conf}"

# REPO_RAW_BASE et REPO_TARBALL_URL sont définis par install.sh au moment de
# l'installation (voir preseed/ et scripts/install.sh) — à adapter une fois
# le dépôt réellement publié.
REPO_RAW_BASE=""
REPO_TARBALL_URL=""
# shellcheck disable=SC1090
[[ -f "$SOURCE_CONF" ]] && source "$SOURCE_CONF"

if [[ -z "$REPO_RAW_BASE" || -z "$REPO_TARBALL_URL" ]]; then
  log "pas de source de mise à jour configurée ($SOURCE_CONF absent ou incomplet) — on continue sans vérifier."
  exit 0
fi

TMP_VERSION_FILE="$(mktemp)"
trap 'rm -f "$TMP_VERSION_FILE"' EXIT

if ! curl --max-time 3 -fsSL "$REPO_RAW_BASE/VERSION" -o "$TMP_VERSION_FILE" 2>/dev/null; then
  log "dépôt injoignable (pas de réseau, ou hors ligne sur ce lieu de tir) — on continue avec la version déjà installée."
  exit 0
fi

remote_version="$(tr -d '[:space:]' < "$TMP_VERSION_FILE")"
local_version=""
[[ -f "$INSTALL_LINK/VERSION" ]] && local_version="$(tr -d '[:space:]' < "$INSTALL_LINK/VERSION")"

if [[ -z "$remote_version" ]]; then
  log "réponse de version distante vide/invalide — on ignore."
  exit 0
fi

if [[ "$remote_version" == "$local_version" ]]; then
  log "déjà à jour (version $local_version)."
  exit 0
fi

log "nouvelle version disponible : $remote_version (actuelle : ${local_version:-aucune}) — téléchargement…"

TMP_TARBALL="$(mktemp --suffix=.tar.gz)"
trap 'rm -f "$TMP_VERSION_FILE" "$TMP_TARBALL"' EXIT

if ! curl --max-time 60 -fsSL "$REPO_TARBALL_URL" -o "$TMP_TARBALL" 2>/dev/null; then
  log "échec du téléchargement de la nouvelle version — on garde la version actuelle."
  exit 0
fi

if ! tar tzf "$TMP_TARBALL" >/dev/null 2>&1; then
  log "archive téléchargée corrompue — on garde la version actuelle."
  exit 0
fi

NEW_RELEASE_DIR="$RELEASES_DIR/${remote_version}-$(date +%s)"
mkdir -p "$NEW_RELEASE_DIR"
if ! tar xzf "$TMP_TARBALL" -C "$NEW_RELEASE_DIR" --strip-components=1; then
  log "échec de l'extraction — on garde la version actuelle."
  rm -rf "$NEW_RELEASE_DIR"
  exit 0
fi

# Contrôle de cohérence minimal avant de basculer dessus : si le portage
# serveur ou l'agent ne sont même pas syntaxiquement valides, on n'y touche
# pas — mieux vaut rester sur une version qui marche que de basculer sur une
# version cassée sans personne sur place pour le réparer.
if ! node --check "$NEW_RELEASE_DIR/server/server.js" 2>/dev/null \
  || ! node --check "$NEW_RELEASE_DIR/server/chrono-core.js" 2>/dev/null \
  || ! node --check "$NEW_RELEASE_DIR/node-agent/agent.js" 2>/dev/null; then
  log "la nouvelle version ne passe pas le contrôle de cohérence de base — on garde la version actuelle."
  rm -rf "$NEW_RELEASE_DIR"
  exit 0
fi

echo "$remote_version" > "$NEW_RELEASE_DIR/VERSION"

TMP_LINK="${INSTALL_LINK}.new"
ln -sfn "$NEW_RELEASE_DIR" "$TMP_LINK"
mv -T "$TMP_LINK" "$INSTALL_LINK"
log "mise à jour appliquée : version $remote_version"

# Conserve seulement les 2 dernières versions (celle en place + une de
# secours), pour permettre un retour en arrière manuel sans accumuler
# indéfiniment de vieilles versions sur la carte SD / le disque.
# shellcheck disable=SC2012
ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | tail -n +3 | xargs -r rm -rf --

exit 0
