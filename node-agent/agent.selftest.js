'use strict';
// Tests d'intégration de l'agent de démarrage (dev uniquement) — sans
// matériel WiFi réel : netctl et le lancement du serveur maître sont
// remplacés par des versions factices qui enregistrent simplement les
// appels, pour vérifier l'ORDRE des opérations et la logique de décision
// (délai par défaut, réponse manuelle, persistance de la config).
const fs = require('fs');
const os = require('os');
const path = require('path');

let failed = false;
function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); failed = true; } else console.log('ok  -', msg); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeFakeNetctl() {
  const calls = [];
  return {
    calls,
    setupTempAp: async (ssid, pass) => { calls.push(['setupTempAp', ssid, pass]); },
    setupMasterAp: async (ssid, pass) => { calls.push(['setupMasterAp', ssid, pass]); },
    joinAsClient: async (ssid, pass) => { calls.push(['joinAsClient', ssid, pass]); },
    teardown: async () => { calls.push(['teardown']); },
  };
}

async function testFreshInstall() {
  console.log('\n--- Scénario A : poste jamais configuré, décision manuelle ---');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-agent-'));
  process.env.CHRONO_STATE_PATH = path.join(tmpDir, 'state.json');
  process.env.CHRONO_KIOSK_TARGET_PATH = path.join(tmpDir, 'kiosk-url');
  delete require.cache[require.resolve('./agent')];
  const { createAgent } = require('./agent');

  const netctl = makeFakeNetctl();
  let spawned = 0;
  const agent = createAgent({
    netctl, port: 8181, countdownSeconds: 30,
    machineId: 'test-machine-A',
    spawnMaster: async () => { spawned++; },
  });

  const runPromise = agent.run();
  await sleep(150); // laisse l'agent démarrer son serveur HTTP local

  const state1 = await (await fetch('http://127.0.0.1:8181/api/state')).json();
  assert(state1.deadlineMs === null, 'aucune configuration précédente => pas de compte à rebours automatique');
  assert(state1.decided === false, 'pas encore décidé');

  const decideRes = await fetch('http://127.0.0.1:8181/api/decide', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'master', networkId: 'test_net' }),
  });
  assert(decideRes.ok, 'la décision manuelle "maître" est acceptée');

  const result = await runPromise;
  assert(result.kioskUrl === 'http://localhost:8090/display.html', 'URL kiosque correcte pour un maître');
  assert(spawned === 1, 'le serveur maître est démarré une fois');
  assert(netctl.calls[0][0] === 'setupTempAp', 'la borne temporaire est montée en premier');
  assert(netctl.calls[1][0] === 'teardown', 'la borne temporaire est démontée avant la config finale');
  assert(netctl.calls[2][0] === 'setupMasterAp', 'la borne fixe du maître est montée ensuite');

  const savedConfig = JSON.parse(fs.readFileSync(process.env.CHRONO_STATE_PATH, 'utf8'));
  assert(savedConfig.lastRole === 'master', 'le rôle "maître" est bien mémorisé');
  assert(savedConfig.selectedNetworkId === 'test_net', 'l\'identifiant de réseau choisi est mémorisé');

  const kioskUrlWritten = fs.readFileSync(process.env.CHRONO_KIOSK_TARGET_PATH, 'utf8');
  assert(kioskUrlWritten === result.kioskUrl, 'l\'URL kiosque est écrite sur disque pour kiosk-launch.sh');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function testAutoResume() {
  console.log('\n--- Scénario B : reprise automatique de la dernière config (écran) ---');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-agent-'));
  process.env.CHRONO_STATE_PATH = path.join(tmpDir, 'state.json');
  process.env.CHRONO_KIOSK_TARGET_PATH = path.join(tmpDir, 'kiosk-url');
  fs.writeFileSync(process.env.CHRONO_STATE_PATH, JSON.stringify({
    lastRole: 'client', selectedNetworkId: 'blabla_54', knownNetworkIds: ['blabla_54'], deviceLabel: null,
  }));
  delete require.cache[require.resolve('./agent')];
  const { createAgent } = require('./agent');

  const netctl = makeFakeNetctl();
  const agent = createAgent({
    netctl, port: 8182, countdownSeconds: 1, // court, pour un test rapide
    machineId: 'test-machine-B',
    spawnMaster: async () => {},
  });

  const runPromise = agent.run();
  await sleep(150);
  const state1 = await (await fetch('http://127.0.0.1:8182/api/state')).json();
  assert(typeof state1.deadlineMs === 'number', 'une configuration précédente déclenche un compte à rebours');
  assert(state1.selectedNetworkId === 'blabla_54', 'l\'identifiant de réseau précédent est proposé par défaut');

  const result = await runPromise; // attend l'application automatique après le délai
  assert(result.decision.source === 'auto', 'la décision a été prise automatiquement, sans intervention');
  assert(result.kioskUrl === 'http://10.42.0.1:8090/display.html', 'URL kiosque correcte pour un écran (IP fixe du maître)');
  assert(netctl.calls.some((c) => c[0] === 'joinAsClient'), 'le poste rejoint le réseau du maître en tant que client');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

(async () => {
  await testFreshInstall();
  await testAutoResume();
  console.log('\nTerminé.', failed ? 'DES TESTS ONT ECHOUE' : 'tous les tests sont passés');
  process.exit(failed ? 1 : 0);
})();
