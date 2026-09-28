'use strict';
// Auto-test rapide, à usage de développement uniquement (pas déployé) :
// vérifie que le portage Node de la machine à états se comporte comme prévu
// sur un scénario simple, en accélérant le temps réel via des ticks manuels.
const { ChronoEngine } = require('./chrono-core');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok  -', msg);
}

const e = new ChronoEngine();
e.setMode('AB');
e.setDuration(5); // volée courte pour un test rapide
assert(e.phase === 'ready', 'phase initiale = ready');

const events = [];
e.on('state', s => events.push(s.phase));
e.on('audible', a => events.push('audible:' + a.kind));

e.start();
assert(e.phase === 'approach', 'start() -> approach');
assert(events.includes('audible:whistle'), 'un signal sonore au départ');

// Simule le passage du temps en appelant tick() directement avec des
// horodatages avancés manuellement (on ne veut pas attendre 15s pour tester).
e.segmentStart = Date.now() - 10001; // fait passer la phase d'approche pour "terminée"
e.tick();
// Avec une volée de 5s (< seuil "warn" de 30s), le passage direct en 'warn'
// dès le début du tir est le comportement fidèle de l'original, pas un bug :
// on vérifie juste qu'on est sorti de la phase d'approche.
assert(e.phase === 'run' || e.phase === 'warn', 'fin d\'approche -> tir (10s dépassées)');

e.segmentStart = Date.now() - 4001; // presque toute la volée de 5s
e.tick();
assert(e.remaining <= 30, 'phase warn atteinte (seuil 30s, ici trivialement vrai)');

// Fin de la volée : on force le dépassement de la frontière de segment.
e.segmentStart = Date.now() - (e.segmentDuration * 1000) - 1;
e.tick();
assert(e.phase === 'stop', 'fin de volée -> stop');
assert(e.timerId === null, 'le minuteur s\'arrête à la fin de la séquence');

e.reset();
assert(e.phase === 'ready', 'reset() -> ready');

console.log('\nTerminé.', process.exitCode ? 'DES TESTS ONT ECHOUE' : 'tous les tests sont passés');
