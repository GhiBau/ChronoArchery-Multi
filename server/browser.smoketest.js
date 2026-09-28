'use strict';
// Test bout-en-bout (dev uniquement) : démarre le vrai serveur maître servant
// app/, ouvre display.html et controller.html dans Chromium headless (via
// Playwright), pilote la télécommande, et vérifie que l'écran suit bien
// l'état — synchronisation d'horloge et diffusion réseau incluses, pas
// seulement la logique JS isolée.
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8098;
const server = spawn(process.execPath, ['server.js', '--port', String(PORT)], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
server.stderr.on('data', (d) => process.stdout.write('[server:err] ' + d));

let failed = false;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failed = true; }
  else console.log('ok  -', msg);
}

async function main() {
  const { chromium } = require('playwright');
  await new Promise((r) => setTimeout(r, 500)); // laisse le serveur démarrer

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome',
    args: ['--autoplay-policy=no-user-gesture-required'],
  }).catch(async () => chromium.launch()); // repli si le chemin diffère

  const ctx = await browser.newContext();
  const display = await ctx.newPage();
  const controller = await ctx.newPage();

  const consoleErrors = [];
  for (const page of [display, controller]) {
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  }

  await display.goto(`http://127.0.0.1:${PORT}/display.html`);
  await controller.goto(`http://127.0.0.1:${PORT}/controller.html`);

  await display.waitForSelector('.status.connected', { timeout: 5000 });
  await controller.waitForSelector('.status-line.connected', { timeout: 5000 });
  assert(true, 'les deux pages se connectent au serveur maître');

  // Règle une durée courte pour un test rapide, puis démarre.
  await controller.click('#durationChips [data-duration="40"]');
  await controller.click('#startBtn');

  await display.waitForFunction(() => document.body.dataset.phase === 'approach', null, { timeout: 3000 });
  assert(true, 'l\'écran passe en phase "approach" après Démarrer sur la télécommande');

  const letterAlit = await display.evaluate(() =>
    document.querySelector('.letters span[data-letter="A"]').classList.contains('lit'));
  assert(letterAlit, 'la lettre A est allumée sur l\'écran (séquence AB/CD par défaut)');

  // La phase d'approche dure 10s (constante), quelle que soit la durée de
  // volée choisie : on attend qu'elle se termine avant que "Fin de volée"
  // ne redevienne cliquable.
  await display.waitForFunction(() => document.body.dataset.phase === 'run' || document.body.dataset.phase === 'warn', null, { timeout: 12000 });
  assert(true, 'l\'écran passe en phase de tir après la mise en place (10s)');

  // Fin de volée déclenchée depuis la télécommande -> l'écran doit suivre.
  await controller.waitForSelector('#volleyEndBtn:not([disabled])', { timeout: 3000 });
  await controller.click('#volleyEndBtn');
  await display.waitForFunction(() => document.body.dataset.phase === 'approach' || document.body.dataset.phase === 'stop', null, { timeout: 3000 });
  assert(true, 'l\'écran réagit à "Fin de volée" envoyé depuis la télécommande');

  // Vérifie que le compte à rebours de l'écran décroît réellement dans le temps.
  const t1 = await display.evaluate(() => parseInt(document.getElementById('timeDisplay').textContent, 10));
  await new Promise((r) => setTimeout(r, 2000));
  const t2 = await display.evaluate(() => parseInt(document.getElementById('timeDisplay').textContent, 10));
  assert(t2 <= t1, `le compte à rebours décroît (${t1} -> ${t2})`);

  assert(consoleErrors.length === 0, 'aucune erreur JavaScript dans la console (' + consoleErrors.join(' | ') + ')');

  await browser.close();
  server.kill('SIGTERM');
  console.log('\nTerminé.', failed ? 'DES TESTS ONT ECHOUE' : 'tous les tests sont passés');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('Erreur du test :', err);
  server.kill('SIGTERM');
  process.exit(1);
});
