'use strict';

/*
 * config.js — configuration locale persistée d'un poste ChronoArchery.
 *
 * Ce fichier mémorise, d'un démarrage à l'autre, quel a été le dernier rôle
 * de CETTE machine (maître ou écran) et le dernier réseau ChronoArchery
 * rejoint (son "identifiant", ex. "blabla_54"). Ce n'est PAS un rôle figé :
 * c'est juste la valeur par défaut proposée à chaque démarrage (voir
 * agent.js) — l'utilisateur peut toujours en changer via le QR code affiché
 * au boot, y compris si une configuration précédente existe.
 *
 * Emplacement par défaut : /etc/chronoarchery/state.json (recouvrable via la
 * variable d'environnement CHRONO_STATE_PATH, utilisé par les tests).
 */

const fs = require('fs');
const path = require('path');

function statePath() {
  return process.env.CHRONO_STATE_PATH || '/etc/chronoarchery/state.json';
}

const DEFAULTS = {
  lastRole: null,       // 'master' | 'client' | null (jamais configuré)
  selectedNetworkId: null, // identifiant du réseau ChronoArchery en cours (ex "blabla_54")
  knownNetworkIds: [],  // historique, le plus récent en tête, pour proposer des raccourcis
  deviceLabel: null,    // nom lisible de cette machine, optionnel (affiché sur l'écran de choix)
};

function load() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const data = JSON.parse(raw);
    return { ...DEFAULTS, ...data };
  } catch (err) {
    return { ...DEFAULTS };
  }
}

function save(state) {
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  // Écriture atomique (fichier temporaire + rename) : on ne veut jamais
  // laisser un fichier de config à moitié écrit si la machine coupe pendant
  // l'écriture.
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
  return state;
}

function remember(state, { role, networkId }) {
  const next = { ...state, lastRole: role };
  if (networkId) {
    next.selectedNetworkId = networkId;
    const history = [networkId, ...state.knownNetworkIds.filter((id) => id !== networkId)];
    next.knownNetworkIds = history.slice(0, 5);
  } else if (role === 'master') {
    // Un maître n'a pas de "networkId à rejoindre" : c'est lui qui le crée.
    // On garde selectedNetworkId tel quel s'il existait déjà (pratique pour
    // repasser client plus tard sans avoir à retaper l'identifiant).
  }
  return next;
}

module.exports = { load, save, remember, statePath, DEFAULTS };
