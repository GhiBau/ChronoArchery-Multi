'use strict';

/*
 * chrono-net.js — connexion réseau partagée par display.html et controller.html.
 *
 * Gère : la connexion WebSocket au maître (avec reconnexion automatique),
 * la synchronisation d'horloge (ping/pong, voir server/protocol.md), et une
 * petite API commune (envoi de commandes, écoute des messages d'état).
 *
 * Chargé en <script> classique (pas de modules ES) pour rester compatible
 * avec de vieux Chromium sur du matériel ancien. Expose window.ChronoNet.
 */

(function (global) {
  function connect(opts) {
    const role = opts.role; // 'display' | 'controller'
    const onWelcome = opts.onWelcome || function () {};
    const onState = opts.onState || function () {};
    const onAudible = opts.onAudible || function () {};
    const onConnectionChange = opts.onConnectionChange || function () {};

    const clientId = getOrCreateClientId();

    let ws = null;
    let reconnectDelayMs = 1000;
    const RECONNECT_MAX_MS = 10000;
    let pingTimer = null;
    let closedByUs = false;

    // --- Synchronisation d'horloge ---
    // On garde les derniers échantillons {rtt, offset} et on retient le plus
    // fiable (rtt le plus faible) pour convertir un horodatage serveur en
    // horodatage local comparable à Date.now().
    let samples = [];
    function clockOffsetMs() {
      if (samples.length === 0) return 0;
      let best = samples[0];
      for (const s of samples) if (s.rtt < best.rtt) best = s;
      return best.offset;
    }
    function toLocalMs(serverTimeMs) {
      return serverTimeMs - clockOffsetMs();
    }

    function wsUrl() {
      if (opts.wsUrl) return opts.wsUrl;
      const proto = (location.protocol === 'https:') ? 'wss://' : 'ws://';
      const host = opts.host || location.host;
      return proto + host + '/ws';
    }

    function sendRaw(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }

    function sendPing() {
      sendRaw({ type: 'ping', t0: Date.now() });
    }

    function open() {
      onConnectionChange('connecting');
      ws = new WebSocket(wsUrl());

      ws.addEventListener('open', () => {
        reconnectDelayMs = 1000;
        onConnectionChange('connected');
        sendRaw({ type: 'hello', role, clientId });
        // Quelques ping rapprochés à la connexion pour affiner tout de suite
        // l'estimation, puis un rythme plus lâche pour suivre la dérive.
        sendPing(); setTimeout(sendPing, 200); setTimeout(sendPing, 500);
        clearInterval(pingTimer);
        pingTimer = setInterval(sendPing, 25000);
      });

      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'pong') {
          const t2 = Date.now();
          const rtt = t2 - msg.t0;
          const offset = msg.serverTime - (msg.t0 + t2) / 2;
          samples.push({ rtt, offset });
          if (samples.length > 5) samples.shift();
        } else if (msg.type === 'welcome') {
          onWelcome(msg.state, toLocalMs);
        } else if (msg.type === 'state') {
          onState(msg, toLocalMs);
        } else if (msg.type === 'audible') {
          onAudible(msg);
        }
      });

      ws.addEventListener('close', () => {
        clearInterval(pingTimer);
        onConnectionChange('disconnected');
        if (closedByUs) return;
        setTimeout(open, reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 1.6, RECONNECT_MAX_MS);
      });

      ws.addEventListener('error', () => {
        try { ws.close(); } catch (e) { /* ignore */ }
      });
    }

    open();

    return {
      cmd(action) { sendRaw({ type: 'cmd', action }); },
      set(key, value) { sendRaw({ type: 'set', key, value }); },
      toLocalMs,
      close() { closedByUs = true; clearInterval(pingTimer); if (ws) ws.close(); },
    };
  }

  function getOrCreateClientId() {
    try {
      let id = localStorage.getItem('chronoarchery-client-id');
      if (!id) {
        id = 'c-' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('chronoarchery-client-id', id);
      }
      return id;
    } catch (e) {
      return 'c-' + Math.random().toString(36).slice(2, 10);
    }
  }

  /* ---------- Audio (signaux sonores), identique à l'original ---------- */
  // Portage direct de la synthèse audio de index.html : un "sifflet" filtré
  // passe-bande, joué localement par CHAQUE écran quand le serveur signale
  // un événement audible — jamais de flux audio envoyé sur le réseau.

  const BEEP_DURATION = 1.0;
  const BEEP_GAP = 0.1;
  const WHISTLE_FREQ = 2200;
  let audioCtx = null;

  function ensureAudio() {
    if (!audioCtx) audioCtx = new (global.AudioContext || global.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function playWhistle(ctx, freq, startTime) {
    const attack = 0.008;
    const release = 0.05;
    const sustainEnd = startTime + BEEP_DURATION - release;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 7;
    filter.connect(ctx.destination);

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0, startTime);
    masterGain.gain.linearRampToValueAtTime(0.5, startTime + attack);
    masterGain.gain.setValueAtTime(0.5, sustainEnd);
    masterGain.gain.linearRampToValueAtTime(0, startTime + BEEP_DURATION);
    masterGain.connect(filter);

    [freq, freq * 1.03].forEach((f) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      osc.connect(masterGain);
      osc.start(startTime);
      osc.stop(startTime + BEEP_DURATION + 0.02);
    });
  }

  function beep(count, soundOn) {
    if (soundOn === false) return;
    const ctx = ensureAudio();
    let t = ctx.currentTime;
    for (let i = 0; i < count; i++) {
      playWhistle(ctx, WHISTLE_FREQ, t);
      t += BEEP_DURATION + BEEP_GAP;
    }
  }

  function unlockAudioOnFirstGesture() {
    const unlock = () => { try { ensureAudio(); } catch (e) { /* ignore */ } };
    ['pointerdown', 'keydown', 'touchstart'].forEach((evt) =>
      global.addEventListener(evt, unlock, { once: true, passive: true }));
  }

  global.ChronoNet = { connect, beep, unlockAudioOnFirstGesture };
})(window);
