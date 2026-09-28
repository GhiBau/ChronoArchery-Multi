'use strict';

/*
 * agent.js — agent de démarrage ChronoArchery : "boot chooser".
 *
 * Tourne sur CHAQUE machine (maître ou écran, Pi ou PC), à CHAQUE démarrage,
 * avant que le navigateur kiosque n'ouvre l'application elle-même. Son
 * travail :
 *
 *   1. Monter une borne WiFi temporaire propre à cette machine (SSID unique,
 *      dérivé de son identifiant matériel) pour qu'un téléphone puisse la
 *      joindre et changer sa configuration, à CHAQUE démarrage — pas
 *      seulement à la première installation.
 *   2. Afficher, sur l'écran de la machine elle-même, la dernière
 *      configuration connue (rôle + identifiant de réseau) comme choix par
 *      défaut, avec un compte à rebours avant application automatique, et un
 *      QR code permettant de changer ce choix depuis un téléphone.
 *   3. Une fois la décision prise (automatiquement ou manuellement),
 *      démonter la borne temporaire, configurer le réseau définitif (borne
 *      fixe si maître, connexion cliente si écran), démarrer le serveur
 *      maître si besoin, et écrire l'URL que le navigateur kiosque doit
 *      ouvrir.
 *
 * Conçu pour être testable sans matériel réseau réel : toute la mécanique
 * WiFi passe par un objet `netctl` injectable (voir lib/netctl.js et
 * agent.selftest.js, qui en fournit une version factice).
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./lib/config');
const netid = require('./lib/netid');
const qrgen = require('./lib/qrgen');
const { real: realNetctl } = require('./lib/netctl');

const DEFAULT_COUNTDOWN_S = 12;
const MASTER_HTTP_PORT = 8090;
const MASTER_FIXED_IP = '10.42.0.1'; // adresse fixe de la borne du maître
const AGENT_PORT = 8080;
const CHOOSER_HTML = fs.readFileSync(path.join(__dirname, 'views', 'chooser.html'), 'utf8');
const KIOSK_TARGET_PATH = process.env.CHRONO_KIOSK_TARGET_PATH || '/run/chronoarchery/kiosk-url';

function getMachineId() {
  try { return fs.readFileSync('/etc/machine-id', 'utf8').trim(); } catch (e) { /* pas Linux / pas dispo */ }
  return os.hostname();
}

function writeKioskTarget(url) {
  try {
    fs.mkdirSync(path.dirname(KIOSK_TARGET_PATH), { recursive: true });
    fs.writeFileSync(KIOSK_TARGET_PATH, url);
  } catch (err) {
    // Non bloquant : en environnement de test, ce chemin peut ne pas être
    // inscriptible — kiosk-launch.sh sait de toute façon relire ce fichier
    // au prochain vrai démarrage.
  }
}

function createAgent(opts = {}) {
  const netctl = opts.netctl || realNetctl;
  const countdownSeconds = opts.countdownSeconds ?? DEFAULT_COUNTDOWN_S;
  const port = opts.port ?? AGENT_PORT;
  const machineId = opts.machineId || getMachineId();
  const spawnMaster = opts.spawnMaster || defaultSpawnMaster;
  const now = opts.now || (() => Date.now());

  let state = config.load();
  const setupSsid = netid.setupSsidFor(machineId);
  const setupPassphrase = netid.SETUP_PASSPHRASE;

  let resolveDecision;
  const decisionPromise = new Promise((resolve) => { resolveDecision = resolve; });
  let decided = false;
  let deadlineMs = null;
  let countdownTimer = null;

  function applyDecisionOnce(decision) {
    if (decided) return;
    decided = true;
    clearTimeout(countdownTimer);
    resolveDecision(decision);
  }

  // Un délai automatique n'a de sens que s'il existe une configuration
  // précédente à reprendre — sur une machine jamais configurée, on attend
  // une décision humaine sans limite de temps.
  if (state.lastRole && state.selectedNetworkId) {
    deadlineMs = now() + countdownSeconds * 1000;
    countdownTimer = setTimeout(() => {
      applyDecisionOnce({ role: state.lastRole, networkId: state.selectedNetworkId, source: 'auto' });
    }, countdownSeconds * 1000);
  }

  async function buildStatePayload() {
    const wifiQr = await qrgen.dataUrl(qrgen.wifiPayload(setupSsid, setupPassphrase));
    const urlQr = await qrgen.dataUrl(`http://10.99.0.1:${port}/`);
    return {
      deviceLabel: state.deviceLabel || machineId.slice(0, 8),
      lastRole: state.lastRole,
      selectedNetworkId: state.selectedNetworkId,
      knownNetworkIds: state.knownNetworkIds,
      deadlineMs,
      nowMs: now(),
      decided,
      setupSsid,
      wifiQr,
      urlQr,
      setupUrl: `http://10.99.0.1:${port}/`,
    };
  }

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(CHOOSER_HTML);
      return;
    }
    if (req.method === 'GET' && req.url === '/api/state') {
      buildStatePayload().then((payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/decide') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch (e) { parsed = {}; }
        const role = parsed.role === 'master' ? 'master' : (parsed.role === 'client' ? 'client' : null);
        if (!role || (role === 'client' && !netid.sanitizeNetworkId(parsed.networkId))) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'role ou identifiant de réseau invalide' }));
          return;
        }
        const networkId = role === 'master'
          ? (netid.sanitizeNetworkId(parsed.networkId) || state.selectedNetworkId || machineId.slice(0, 6))
          : netid.sanitizeNetworkId(parsed.networkId);
        applyDecisionOnce({ role, networkId, source: 'manual' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404); res.end('Introuvable');
  });

  async function run() {
    await netctl.setupTempAp(setupSsid, setupPassphrase);
    httpServer.listen(port);

    const decision = await decisionPromise;
    httpServer.close();

    state = config.remember(state, decision);
    config.save(state);

    await netctl.teardown();

    const ssid = netid.ssidFor(decision.networkId);
    const passphrase = netid.passphraseFor(decision.networkId);
    let kioskUrl;

    if (decision.role === 'master') {
      await netctl.setupMasterAp(ssid, passphrase);
      await spawnMaster({ port: MASTER_HTTP_PORT });
      kioskUrl = `http://localhost:${MASTER_HTTP_PORT}/display.html`;
    } else {
      await netctl.joinAsClient(ssid, passphrase);
      kioskUrl = `http://${MASTER_FIXED_IP}:${MASTER_HTTP_PORT}/display.html`;
    }

    writeKioskTarget(kioskUrl);
    return { decision, kioskUrl, state };
  }

  return { run, decisionPromise, applyDecisionOnce, httpServer, buildStatePayload };
}

// Démarre le serveur maître via systemd plutôt qu'en sous-processus détaché :
// ça permet à systemd (Restart=always, voir systemd/chronoarchery-master.service)
// de le relancer tout seul s'il plante en cours de séance, sans dépendre de
// l'agent (qui, lui, a déjà terminé son travail à ce stade). Le service
// n'est volontairement PAS activé au démarrage (pas de [Install]) : c'est
// l'agent qui décide, à chaque boot, s'il doit tourner ou non.
function defaultSpawnMaster({ port }) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    execFile('systemctl', ['start', 'chronoarchery-master.service'], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) { reject(new Error('démarrage du service maître impossible : ' + (stderr || err.message))); return; }
      resolve();
    });
  }).catch((err) => {
    // En développement / hors systemd, on retombe sur un lancement direct
    // pour ne pas bloquer les tests manuels sur un poste non installé.
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js'), '--port', String(port)], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
  });
}

module.exports = { createAgent, MASTER_HTTP_PORT, MASTER_FIXED_IP, AGENT_PORT, DEFAULT_COUNTDOWN_S };

if (require.main === module) {
  createAgent({}).run().then((result) => {
    console.log('[chronoarchery-agent] décision appliquée :', JSON.stringify(result.decision));
    console.log('[chronoarchery-agent] le navigateur kiosque doit ouvrir :', result.kioskUrl);
    process.exit(0);
  }).catch((err) => {
    console.error('[chronoarchery-agent] erreur :', err);
    process.exit(1);
  });
}
