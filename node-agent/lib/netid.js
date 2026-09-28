'use strict';

/*
 * netid.js — dérivation des identifiants réseau WiFi ChronoArchery.
 *
 * Principe (voir la conversation de conception) : plutôt que de faire
 * transiter des identifiants WiFi entre appareils, chaque machine sait déjà,
 * à partir d'un simple "identifiant de réseau" choisi par le club (ex.
 * "blabla_54"), calculer elle-même le SSID et le mot de passe du réseau
 * ChronoArchery correspondant. Ça évite d'avoir à relayer un mot de passe
 * WiFi au moment de l'appairage : le téléphone ne transmet que l'identifiant
 * (un texte court et mémorisable), jamais un secret.
 *
 * ATTENTION SÉCURITÉ : ce n'est pas conçu pour résister à un attaquant
 * déterminé — c'est une convenance pour éviter que deux clubs voisins avec
 * chacun leur système ChronoArchery ne se marchent dessus, pas un mécanisme
 * de sécurité au sens strict. Le réseau reste de toute façon un WiFi local
 * fermé, sans accès Internet, sur lequel ne transitent que des commandes de
 * chronomètre.
 */

const crypto = require('crypto');

// Un "poivre" fixe, commun à toutes les installations ChronoArchery — pas un
// secret à proprement parler (il est dans ce fichier, public), juste ce qui
// distingue un mot de passe ChronoArchery d'un mot de passe WiFi générique.
const PEPPER = 'chronoarchery-v1';

function sanitizeNetworkId(id) {
  return String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
}

function ssidFor(networkId) {
  const id = sanitizeNetworkId(networkId) || 'defaut';
  return `ChronoArchery-${id}`;
}

function passphraseFor(networkId) {
  const id = sanitizeNetworkId(networkId) || 'defaut';
  // 16 caractères hexadécimaux : largement au-dessus du minimum WPA2 (8),
  // dérivés de façon reproductible pour que toute machine connaissant
  // l'identifiant retrouve le même mot de passe sans jamais le stocker ni
  // le transmettre séparément.
  return crypto.createHash('sha256').update(PEPPER + ':' + id).digest('hex').slice(0, 16);
}

// SSID de la borne temporaire "non configurée" qu'une machine expose à
// CHAQUE démarrage (voir agent.js) pour qu'un téléphone puisse la joindre et
// changer son rôle, y compris quand une configuration précédente existe déjà.
// Dérivé d'un identifiant stable de la machine (adresse MAC, deja unique par
// construction) pour que plusieurs postes non configurés présents en même
// temps restent distinguables les uns des autres.
function setupSsidFor(machineId) {
  const short = crypto.createHash('sha256').update(String(machineId || 'unknown')).digest('hex').slice(0, 6);
  return `ChronoSetup-${short}`;
}

const SETUP_PASSPHRASE = 'chronoarchery-setup';

module.exports = { sanitizeNetworkId, ssidFor, passphraseFor, setupSsidFor, SETUP_PASSPHRASE };
