'use strict';
// Test d'intégration rapide (dev uniquement) : démarre le serveur en
// sous-processus, connecte un client "controller" et un client "display",
// vérifie que les commandes de l'un se traduisent en diffusion vers l'autre.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 8099;
const tmpAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-app-'));
fs.writeFileSync(path.join(tmpAppDir, 'index.html'), '<!doctype html><title>test</title>');

const server = spawn(process.execPath, ['server.js', '--port', String(PORT), '--app-dir', tmpAppDir], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let failed = false;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failed = true; }
  else console.log('ok  -', msg);
}

server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
server.stderr.on('data', (d) => process.stdout.write('[server:err] ' + d));

setTimeout(() => {
  const display = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const controller = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);

  let displayGotWelcome = false;
  let displaySawApproach = false;
  let displaySawAudible = false;
  let controllerCmdRejectedWhenNotHello = false;

  display.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'welcome') displayGotWelcome = true;
    if (msg.type === 'state' && msg.phase === 'approach') displaySawApproach = true;
    if (msg.type === 'audible') displaySawAudible = true;
  });

  display.on('open', () => {
    display.send(JSON.stringify({ type: 'hello', role: 'display', clientId: 'test-display' }));
  });

  controller.on('open', () => {
    controller.send(JSON.stringify({ type: 'hello', role: 'controller', clientId: 'test-controller' }));
    setTimeout(() => {
      controller.send(JSON.stringify({ type: 'set', key: 'duration', value: 40 }));
      controller.send(JSON.stringify({ type: 'cmd', action: 'start' }));
    }, 150);

    // Vérifie la synchro d'horloge : ping -> pong.
    const t0 = Date.now();
    controller.send(JSON.stringify({ type: 'ping', t0 }));
  });

  let sawPong = false;
  controller.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'pong' && typeof msg.serverTime === 'number') sawPong = true;
  });

  setTimeout(() => {
    assert(displayGotWelcome, 'le display reçoit un message welcome à la connexion');
    assert(displaySawApproach, 'le display reçoit la phase "approach" après start() du controller');
    assert(displaySawAudible, 'le display reçoit un événement audible');
    assert(sawPong, 'le ping/pong de synchro d\'horloge répond');

    display.close(); controller.close();
    server.kill('SIGTERM');
    fs.rmSync(tmpAppDir, { recursive: true, force: true });
    setTimeout(() => {
      console.log('\nTerminé.', failed ? 'DES TESTS ONT ECHOUE' : 'tous les tests sont passés');
      process.exit(failed ? 1 : 0);
    }, 200);
  }, 800);
}, 400);
