'use strict';

/*
 * server.js — serveur du poste "maître" ChronoArchery.
 *
 * Rôle : servir les fichiers statiques de l'appli (../app), faire autorité
 * sur la machine à états (chrono-core.js) et diffuser son état à tous les
 * écrans et à la télécommande connectés en WebSocket. Voir protocol.md pour
 * le détail des messages échangés.
 *
 * Ce serveur ne gère PAS le réseau WiFi (point d'accès, etc.) ni le choix du
 * rôle maître/écran de la machine — c'est le rôle de node-agent/agent.js,
 * qui démarre (ou non) ce processus une fois le rôle "maître" confirmé pour
 * cette session (voir plus haut dans la conversation : le rôle est choisi à
 * chaque démarrage, pas figé une fois pour toutes).
 *
 * Démarrage : node server.js [--port 8090] [--app-dir ../app]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { ChronoEngine } = require('./chrono-core');

function parseArgs(argv) {
  const args = { port: 8090, appDir: path.join(__dirname, '..', 'app') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--app-dir') args.appDir = path.resolve(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  // Empêche toute évasion du dossier app/ (../../etc/passwd et compagnie).
  const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(args.appDir, safePath);
  if (!filePath.startsWith(args.appDir)) {
    res.writeHead(403); res.end('Interdit'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Introuvable : ' + reqPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------- Moteur de chrono (autorité) ---------- */

const engine = new ChronoEngine();

/* ---------- Serveur HTTP + WebSocket ---------- */

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, phase: engine.phase, clients: wss ? wss.clients.size : 0 }));
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

engine.on('state', (snapshot) => broadcast({ type: 'state', ...snapshot }));
engine.on('audible', (a) => broadcast({ type: 'audible', ...a }));

wss.on('connection', (ws) => {
  ws.role = null;
  ws.clientId = null;

  send(ws, { type: 'welcome', serverTimeMs: Date.now(), state: engine.snapshot() });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (err) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'hello':
        ws.role = (msg.role === 'controller') ? 'controller' : 'display';
        ws.clientId = typeof msg.clientId === 'string' ? msg.clientId : crypto.randomUUID();
        break;

      case 'ping':
        send(ws, { type: 'pong', t0: msg.t0, serverTime: Date.now() });
        break;

      case 'cmd':
        // Seule la télécommande peut agir sur le déroulé de la séquence.
        if (ws.role !== 'controller') return;
        if (typeof engine[msg.action] === 'function' &&
            ['start', 'startOrResume', 'volleyEnd', 'emergencyStop', 'resume', 'reset'].includes(msg.action)) {
          engine[msg.action]();
        }
        break;

      case 'set':
        if (ws.role !== 'controller') return;
        if (msg.key === 'mode') engine.setMode(msg.value);
        else if (msg.key === 'duration') engine.setDuration(msg.value);
        else if (msg.key === 'sound') engine.setSound(msg.value);
        else if (msg.key === 'duelStarter') engine.setDuelStarter(msg.value);
        else if (msg.key === 'switchSide') engine.switchSide();
        break;

      default:
        break;
    }
  });
});

httpServer.listen(args.port, () => {
  console.log(`[chronoarchery-master] écoute sur http://0.0.0.0:${args.port} ` +
    `(fichiers servis depuis ${args.appDir})`);
});

// Arrêt propre : utile en systemd (ExecStop / Restart=always) comme en
// développement (Ctrl+C).
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
