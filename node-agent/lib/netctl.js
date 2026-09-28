'use strict';

/*
 * netctl.js — pilotage réseau, par appel aux scripts système (scripts/net-*.sh).
 *
 * Toute la mécanique hostapd/dnsmasq/wpa_supplicant vit dans des scripts bash
 * séparés (voir scripts/), pas ici : agent.js n'a besoin que de savoir QUOI
 * demander (monter une borne temporaire, monter la borne fixe du maître,
 * rejoindre le réseau du maître en client, tout couper), pas COMMENT c'est
 * fait au niveau système. Ça permet aussi de tester toute la logique de
 * décision de l'agent sans avoir de vraie carte WiFi sous la main (voir
 * agent.selftest.js, qui injecte une implémentation factice).
 */

const { execFile } = require('child_process');
const path = require('path');

const SCRIPTS_DIR = process.env.CHRONO_SCRIPTS_DIR || path.join(__dirname, '..', '..', 'scripts');

// Ni agent.js ni le service kiosque ne tournent en utilisateur limité — voir
// systemd/chronoarchery-kiosk.service, qui s'exécute en root (choix assumé :
// c'est un poste dédié à un seul usage, pas un poste multi-utilisateurs à
// cloisonner). Pas besoin de sudo ici, donc pas de fichier sudoers à
// maintenir en plus des scripts eux-mêmes.
function run(script, args) {
  return new Promise((resolve, reject) => {
    execFile('bash', [path.join(SCRIPTS_DIR, script), ...args], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`${script} ${args.join(' ')} a échoué : ${stderr || err.message}`)); return; }
      resolve(stdout.trim());
    });
  });
}

// Implémentation réelle : chaque méthode appelle le script bash correspondant.
const real = {
  setupTempAp(ssid, passphrase) { return run('net-setup-ap.sh', ['--mode', 'temp', '--ssid', ssid, '--pass', passphrase]); },
  setupMasterAp(ssid, passphrase) { return run('net-setup-ap.sh', ['--mode', 'master', '--ssid', ssid, '--pass', passphrase]); },
  joinAsClient(ssid, passphrase) { return run('net-join.sh', ['--ssid', ssid, '--pass', passphrase]); },
  teardown() { return run('net-teardown.sh', []); },
};

module.exports = { real, SCRIPTS_DIR };
