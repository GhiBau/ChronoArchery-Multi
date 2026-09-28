#!/usr/bin/env bash
# install.sh — installation ChronoArchery-kiosque sur une base Debian (ou
# Raspberry Pi OS) fraîchement installée. Point d'entrée unique appelé soit :
#   - par le `late_command` du preseed Debian (voir preseed/preseed.cfg),
#   - à la main, pour un premier test sur un vieil ordinateur portable :
#       sudo bash install.sh --source-dir /chemin/vers/chronoarchery-kiosk
#
# Ne touche jamais aux images/paquets de base : uniquement des paquets APT
# standard + les fichiers de ce projet, déployés dans /opt/chronoarchery.
# Voir README.md pour le déroulé complet et les prérequis.

set -euo pipefail

log() { echo "[install] $*"; }
die() { echo "[install] ERREUR: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "ce script doit être exécuté en root (sudo bash install.sh ...)"

SOURCE_DIR=""
REPO_RAW_BASE_ARG=""
REPO_TARBALL_URL_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-dir) SOURCE_DIR="$2"; shift 2 ;;
    --repo-raw-base) REPO_RAW_BASE_ARG="$2"; shift 2 ;;
    --repo-tarball-url) REPO_TARBALL_URL_ARG="$2"; shift 2 ;;
    *) die "option inconnue : $1" ;;
  esac
done

# Chemins recouvrables par l'environnement uniquement pour les tests
# automatisés (voir install.selftest.sh) — en usage réel, toujours les
# valeurs par défaut ci-dessous.
INSTALL_LINK="${CHRONO_INSTALL_LINK:-/opt/chronoarchery}"
RELEASES_DIR="${CHRONO_RELEASES_DIR:-/opt/chronoarchery-releases}"
CONF_DIR="${CHRONO_CONF_DIR:-/etc/chronoarchery}"
SYSTEMD_DIR="${CHRONO_SYSTEMD_DIR:-/etc/systemd/system}"

if [[ "${CHRONO_SKIP_APT:-0}" == "1" ]]; then
  log "CHRONO_SKIP_APT=1 : installation des paquets système ignorée (mode test)"
else
  log "mise à jour des paquets et installation des dépendances système…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
    chromium xserver-xorg xinit openbox unclutter \
    hostapd dnsmasq wpasupplicant isc-dhcp-client iw \
    nodejs npm curl ca-certificates
  # Sur Debian, le paquet s'appelle 'chromium' (pas 'chromium-browser' comme
  # sur Ubuntu récent, où il n'est de toute façon plus qu'un wrapper snap) —
  # à vérifier une fois sur l'installation Debian réelle avant de déployer en
  # série : `apt-cache policy chromium`. Voir README, section vérifications.
fi

log "préparation de $RELEASES_DIR et $CONF_DIR"
mkdir -p "$RELEASES_DIR" "$CONF_DIR"

TIMESTAMP="$(date +%s)"
NEW_RELEASE_DIR="$RELEASES_DIR/local-$TIMESTAMP"

if [[ -n "$SOURCE_DIR" ]]; then
  [[ -d "$SOURCE_DIR" ]] || die "--source-dir '$SOURCE_DIR' introuvable"
  log "copie des fichiers depuis $SOURCE_DIR (installation locale, sans réseau de dépôt)"
  mkdir -p "$NEW_RELEASE_DIR"
  cp -a "$SOURCE_DIR"/. "$NEW_RELEASE_DIR"/
  # Nettoyage de ce qui ne doit pas partir en production : dépendances déjà
  # installées côté développement (réinstallées juste après, propres) et
  # scripts de test, qui n'ont rien à faire sur un poste déployé.
  find "$NEW_RELEASE_DIR" -maxdepth 3 -type d -name node_modules -exec rm -rf {} +
  find "$NEW_RELEASE_DIR" -name '*.selftest.js' -delete
  rm -rf "$NEW_RELEASE_DIR/.git"
  [[ -f "$NEW_RELEASE_DIR/VERSION" ]] || echo "local-$TIMESTAMP" > "$NEW_RELEASE_DIR/VERSION"
else
  [[ -n "$REPO_TARBALL_URL_ARG" ]] || die "ni --source-dir ni --repo-tarball-url fournis : rien à installer. Voir README."
  log "téléchargement depuis $REPO_TARBALL_URL_ARG"
  TMP_TARBALL="$(mktemp --suffix=.tar.gz)"
  curl --max-time 60 -fsSL "$REPO_TARBALL_URL_ARG" -o "$TMP_TARBALL" || die "échec du téléchargement"
  mkdir -p "$NEW_RELEASE_DIR"
  tar xzf "$TMP_TARBALL" -C "$NEW_RELEASE_DIR" --strip-components=1
  rm -f "$TMP_TARBALL"
fi

log "installation des dépendances Node (production uniquement)"
(cd "$NEW_RELEASE_DIR/server" && npm install --omit=dev --no-audit --no-fund)
(cd "$NEW_RELEASE_DIR/node-agent" && npm install --omit=dev --no-audit --no-fund)

for script in "$NEW_RELEASE_DIR"/scripts/*.sh; do chmod +x "$script"; done

log "bascule de $INSTALL_LINK vers la nouvelle installation"
ln -sfn "$NEW_RELEASE_DIR" "${INSTALL_LINK}.new"
mv -T "${INSTALL_LINK}.new" "$INSTALL_LINK"

log "écriture de la configuration de mise à jour ($CONF_DIR/update-source.conf)"
{
  echo "# Source utilisée par scripts/update-check.sh pour vérifier et"
  echo "# télécharger les nouvelles versions. À ajuster si le dépôt réel"
  echo "# diffère (nom du dépôt, branche, etc.)."
  echo "REPO_RAW_BASE=\"${REPO_RAW_BASE_ARG:-https://raw.githubusercontent.com/ghibau/chronoarchery-kiosk/main}\""
  echo "REPO_TARBALL_URL=\"${REPO_TARBALL_URL_ARG:-https://github.com/ghibau/chronoarchery-kiosk/archive/refs/heads/main.tar.gz}\""
} > "$CONF_DIR/update-source.conf"

log "installation des unités systemd"
mkdir -p "$SYSTEMD_DIR"
cp "$INSTALL_LINK/systemd/chronoarchery-kiosk.service" "$SYSTEMD_DIR/"
cp "$INSTALL_LINK/systemd/chronoarchery-master.service" "$SYSTEMD_DIR/"

if [[ "${CHRONO_SKIP_SYSTEMD:-0}" == "1" ]]; then
  log "CHRONO_SKIP_SYSTEMD=1 : activation systemd ignorée (mode test — pas de systemd disponible ici)"
else
  systemctl daemon-reload
  systemctl enable chronoarchery-kiosk.service
  # chronoarchery-master.service n'est PAS activé ici : voir son fichier, il
  # est démarré à la demande par l'agent, pas au boot.
  log "pas d'environnement de bureau : démarrage direct en mode texte + kiosque"
  systemctl set-default multi-user.target
fi

log "installation terminée. Redémarrez pour lancer le poste en mode kiosque :"
log "  reboot"
log ""
log "Au premier démarrage, aucune configuration précédente n'existe : l'écran"
log "attendra qu'un téléphone scanne le QR code affiché pour déclarer le rôle"
log "de ce poste (maître ou écran). Voir README.md."
