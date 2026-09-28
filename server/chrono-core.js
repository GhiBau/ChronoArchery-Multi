'use strict';

/*
 * chrono-core.js — moteur de chronométrage ChronoArchery, portage serveur.
 *
 * Ceci est un portage Node.js de la machine à états qui tourne aujourd'hui
 * directement dans index.html (voir le dépôt ghibau/chronoarchery). La
 * logique métier (séquences, phases, rattrapage) est volontairement gardée
 * IDENTIQUE au comportement du client existant : mêmes constantes, mêmes
 * transitions, mêmes règles de rattrapage. Seule la base de temps change :
 *   - le client (mode solo, sans rôle réseau) utilise performance.now(),
 *     monotone mais propre à un seul appareil ;
 *   - ce moteur serveur utilise Date.now() (temps "epoch"), qui a le mérite
 *     d'être un nombre que tous les écrans du réseau peuvent interpréter,
 *     une fois corrigé par leur propre décalage d'horloge (voir clocksync.js
 *     côté client et le protocole décrit dans protocol.md).
 *
 * Le serveur est la seule autorité : il ne fait QUE tourner cette machine à
 * états et notifier ses abonnés (les écrans, et l'onglet du maître lui-même)
 * via des évènements 'state' (à afficher) et 'audible' (à faire biper).
 * Aucun écran ne recalcule la séquence de son côté — il ne fait qu'attendre
 * l'instant (absolu, en temps serveur) de la prochaine frontière et afficher
 * le compte à rebours correspondant.
 *
 * Historique des noms : les fonctions ci-dessous reprennent délibérément les
 * noms du fichier index.html d'origine (beginSegment, advance, tick,
 * finishSequence, setPhase...) pour qu'un futur rapprochement des deux
 * implémentations (client solo / serveur) reste facile à faire au besoin.
 */

const EventEmitter = require('events');

const APPROACH_DURATION = 10;
const DUEL_SHOT_DURATION = 20;
const DUEL_TOTAL_SHOTS = 6; // 3 flèches chacun, tir alterné
const TICK_MS = 100;
const EMERGENCY_BEEPS = 5;
const END_BEEPS = 3;
// Au-delà de ce retard (s) sur une transition, on considère qu'on rattrape
// du temps déjà écoulé (ex : serveur qui a été mis en pause) : on enchaîne
// sans biper, comme le fait le client solo.
const CATCHUP_SILENT_AFTER = 1.5;

const VALID_MODES = new Set(['AB', 'ABC', 'ABCD', 'DUEL']);
const VALID_DURATIONS = new Set([120, 90, 40]);

function otherArcher(a) { return a === 'A' ? 'B' : 'A'; }

class ChronoEngine extends EventEmitter {
  constructor() {
    super();

    this.totalDuration = 120;
    this.remaining = 120;
    this.segmentDuration = 120;
    this.segmentStart = Date.now(); // horodatage serveur (epoch ms)
    this.mode = 'ABCD';
    this.side = 'AB';
    this.nextABCDStart = 'AB';
    this.abcdLeg = 1;
    this.duelStarter = 'A';
    this.duelStep = 0;
    this.soundOn = true;
    this.timerId = null;
    this.phase = 'ready'; // ready | approach | run | warn | halted | stop
    this.haltedFrom = null;
  }

  /* ---------- Aides ---------- */

  duelShooterAt(step) {
    return step % 2 === 0 ? this.duelStarter : otherArcher(this.duelStarter);
  }

  activeLetters() {
    const { mode, side, phase, duelStarter, duelStep } = this;
    if (mode === 'AB') return ['A', 'B'];
    if (mode === 'ABC') return ['A', 'B', 'C'];
    if (mode === 'ABCD') return side === 'AB' ? ['A', 'B'] : ['C', 'D'];
    if (mode === 'DUEL') {
      if (phase === 'approach' || phase === 'ready') return [duelStarter];
      return [this.duelShooterAt(duelStep)];
    }
    return [];
  }

  syncReadyPreview() {
    if (this.mode === 'ABCD') this.side = this.nextABCDStart;
  }

  /* ---------- Snapshot public (envoyé aux écrans) ---------- */

  snapshot() {
    return {
      phase: this.phase,
      mode: this.mode,
      side: this.side,
      letters: this.activeLetters(),
      duelStarter: this.duelStarter,
      duelStep: this.duelStep,
      soundOn: this.soundOn,
      totalDuration: this.totalDuration,
      nextABCDStart: this.nextABCDStart,
      // Horodatages en temps serveur (epoch ms) : c'est à l'écran de les
      // interpréter avec son propre décalage d'horloge.
      segmentStartMs: this.segmentStart,
      segmentDurationMs: this.segmentDuration * 1000,
      serverTimeMs: Date.now(),
    };
  }

  emitState() {
    this.emit('state', this.snapshot());
  }

  emitAudible(kind, count) {
    // kind sert seulement à la journalisation / au débogage ; le nombre de
    // bips et la fréquence sont décidés côté écran (Web Audio ne peut pas
    // être piloté depuis le serveur), mais l'instant, lui, fait autorité ici.
    this.emit('audible', { kind, count, atMs: Date.now() });
  }

  /* ---------- Séquence ---------- */

  beginSegment(duration, startAt) {
    this.segmentDuration = duration;
    this.segmentStart = (startAt === undefined) ? Date.now() : startAt;
    this.remaining = duration;
  }

  setPhase(newPhase) {
    this.phase = newPhase;
  }

  advance(audible) {
    const boundary = this.segmentStart + this.segmentDuration * 1000;

    if (this.phase === 'approach') {
      if (this.mode === 'DUEL') this.duelStep = 0;
      this.beginSegment(this.mode === 'DUEL' ? DUEL_SHOT_DURATION : this.totalDuration, boundary);
      this.setPhase('run');
      if (audible) this.emitAudible('whistle', 1);
      return true;
    }

    if (this.mode === 'DUEL') {
      if (this.duelStep < DUEL_TOTAL_SHOTS - 1) {
        this.duelStep++;
        this.beginSegment(DUEL_SHOT_DURATION, boundary);
        this.setPhase('run');
        if (audible) this.emitAudible('whistle', 1);
        return true;
      }
      this.finishSequence(audible);
      return false;
    }

    if (this.mode === 'ABCD' && this.abcdLeg === 1) {
      this.abcdLeg = 2;
      this.side = this.side === 'AB' ? 'CD' : 'AB';
      this.beginSegment(APPROACH_DURATION, boundary);
      this.setPhase('approach');
      if (audible) this.emitAudible('whistle', 2);
      return true;
    }

    this.finishSequence(audible);
    return false;
  }

  finishSequence(audible) {
    clearInterval(this.timerId);
    this.timerId = null;
    this.setPhase('stop');
    if (audible !== false) this.emitAudible('end', END_BEEPS);
    if (this.mode === 'ABCD') {
      this.nextABCDStart = this.nextABCDStart === 'AB' ? 'CD' : 'AB';
    }
  }

  tick() {
    if (this.timerId === null) return;
    const now = Date.now();
    let guard = 0;

    while (true) {
      this.remaining = this.segmentDuration - (now - this.segmentStart) / 1000;
      if (this.remaining > 0) break;
      const lateBy = -this.remaining;
      this.remaining = 0;
      this.emitState();
      if (!this.advance(lateBy < CATCHUP_SILENT_AFTER)) { this.emitState(); return; }
      if (++guard > 60) break;
    }

    if (this.mode !== 'DUEL' && this.phase === 'run' && this.remaining <= 30) {
      this.setPhase('warn');
    }
    this.emitState();
  }

  start() {
    if (this.timerId) return;
    if (this.mode === 'ABCD') {
      this.side = this.nextABCDStart;
      this.abcdLeg = 1;
    }
    if (this.mode === 'DUEL') this.duelStep = 0;
    this.beginSegment(APPROACH_DURATION);
    this.setPhase('approach');
    this.emitAudible('whistle', 2);
    this.emitState();
    this.timerId = setInterval(() => this.tick(), TICK_MS);
  }

  volleyEnd() {
    if (!this.timerId) return;
    this.segmentStart = Date.now() - this.segmentDuration * 1000;
    this.remaining = 0;
    this.emitState();
    this.advance(true);
    this.emitState();
  }

  emergencyStop() {
    if (!this.timerId) return;
    clearInterval(this.timerId);
    this.timerId = null;
    this.remaining = Math.max(0, this.segmentDuration - (Date.now() - this.segmentStart) / 1000);
    this.haltedFrom = this.phase;
    this.setPhase('halted');
    this.emitAudible('emergency', EMERGENCY_BEEPS);
    this.emitState();
  }

  resume() {
    if (this.timerId || this.haltedFrom === null) return;
    this.segmentStart = Date.now() - (this.segmentDuration - this.remaining) * 1000;
    this.setPhase(this.haltedFrom);
    this.haltedFrom = null;
    this.emitAudible('whistle', 1);
    this.emitState();
    this.timerId = setInterval(() => this.tick(), TICK_MS);
  }

  startOrResume() {
    if (this.phase === 'halted') this.resume(); else this.start();
  }

  reset() {
    clearInterval(this.timerId);
    this.timerId = null;
    this.remaining = (this.mode === 'DUEL') ? DUEL_SHOT_DURATION : this.totalDuration;
    this.segmentDuration = this.remaining;
    this.segmentStart = Date.now();
    this.abcdLeg = 1;
    this.duelStep = 0;
    this.haltedFrom = null;
    this.setPhase('ready');
    this.syncReadyPreview();
    this.emitState();
  }

  /* ---------- Réglages (équivalent des chips de la télécommande) ---------- */

  setMode(newMode) {
    if (!VALID_MODES.has(newMode)) return;
    // Un changement de séquence ne doit avoir d'effet qu'au repos : on ne
    // permet pas de changer les règles au milieu d'une volée en cours.
    if (this.timerId || this.phase === 'halted') return;
    this.mode = newMode;
    this.nextABCDStart = 'AB';
    this.abcdLeg = 1;
    this.duelStep = 0;
    this.remaining = (newMode === 'DUEL') ? DUEL_SHOT_DURATION : this.totalDuration;
    this.segmentDuration = this.remaining;
    this.segmentStart = Date.now();
    this.syncReadyPreview();
    this.emitState();
  }

  setDuelStarter(letter) {
    if (letter !== 'A' && letter !== 'B') return;
    this.duelStarter = letter;
    this.emitState();
  }

  switchSide() {
    if (this.timerId || this.phase === 'halted') return;
    this.side = this.side === 'AB' ? 'CD' : 'AB';
    this.nextABCDStart = this.side;
    this.emitState();
  }

  setDuration(seconds) {
    const s = parseInt(seconds, 10);
    if (!Number.isFinite(s) || s < 5 || s > 600) return;
    if (this.timerId || this.phase === 'halted') return;
    this.totalDuration = s;
    if (this.mode !== 'DUEL') {
      this.remaining = s;
      this.segmentDuration = s;
      this.segmentStart = Date.now();
    }
    this.emitState();
  }

  setSound(on) {
    this.soundOn = !!on;
    this.emitState();
  }
}

module.exports = { ChronoEngine, VALID_MODES, VALID_DURATIONS };
