'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let failed = false;
function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); failed = true; } else console.log('ok  -', msg); }

// --- netid.js ---
const netid = require('./lib/netid');
assert(netid.ssidFor('blabla_54') === 'ChronoArchery-blabla_54', 'ssidFor() construit le bon SSID');
assert(netid.ssidFor('Blabla 54!!') === 'ChronoArchery-blabla54', 'ssidFor() assainit les caractères invalides');
assert(netid.passphraseFor('blabla_54') === netid.passphraseFor('blabla_54'), 'passphraseFor() est déterministe');
assert(netid.passphraseFor('blabla_54') !== netid.passphraseFor('autre_club'), 'passphraseFor() diffère selon l\'identifiant');
assert(netid.passphraseFor('blabla_54').length >= 8, 'le mot de passe généré respecte le minimum WPA2 (8 car.)');
assert(netid.setupSsidFor('AA:BB:CC') === netid.setupSsidFor('AA:BB:CC'), 'setupSsidFor() est déterministe pour une même machine');
assert(netid.setupSsidFor('AA:BB:CC') !== netid.setupSsidFor('DD:EE:FF'), 'setupSsidFor() diffère selon la machine');

// --- config.js ---
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-cfg-'));
process.env.CHRONO_STATE_PATH = path.join(tmpDir, 'sub', 'state.json');
const config = require('./lib/config');

let state = config.load();
assert(state.lastRole === null, 'état par défaut : aucun rôle connu');

state = config.remember(state, { role: 'client', networkId: 'blabla_54' });
config.save(state);
const reloaded = config.load();
assert(reloaded.lastRole === 'client', 'le rôle est bien mémorisé après sauvegarde');
assert(reloaded.selectedNetworkId === 'blabla_54', 'l\'identifiant de réseau est mémorisé');
assert(reloaded.knownNetworkIds[0] === 'blabla_54', 'l\'historique des réseaux connus est mis à jour');

state = config.remember(reloaded, { role: 'client', networkId: 'autre_club' });
config.save(state);
const reloaded2 = config.load();
assert(reloaded2.knownNetworkIds.length === 2, 'l\'historique accumule plusieurs réseaux connus');
assert(reloaded2.knownNetworkIds[0] === 'autre_club', 'le réseau le plus récent est en tête de l\'historique');

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('\nTerminé.', failed ? 'DES TESTS ONT ECHOUE' : 'tous les tests sont passés');
process.exit(failed ? 1 : 0);
