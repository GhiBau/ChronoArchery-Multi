# Protocole WebSocket ChronoArchery (maître ↔ écrans/télécommande)

Tous les messages sont des objets JSON, un par frame WebSocket. Le serveur
(qui tourne sur le poste maître, voir `server.js`) est la seule autorité :
aucun client (écran ou télécommande) ne recalcule la séquence de son côté.

## Client → serveur

- `{"type":"hello","role":"display"|"controller","clientId":"<uuid>"}`
  Premier message envoyé après connexion. `clientId` est généré et conservé
  par le client (localStorage) pour retrouver le même identifiant après une
  reconnexion — utile pour les journaux du serveur, pas indispensable au
  fonctionnement.

- `{"type":"cmd","action":"start"|"startOrResume"|"volleyEnd"|"emergencyStop"|"resume"|"reset"}`
  Envoyé uniquement par un client `role:"controller"`. Le serveur ignore ces
  messages venant d'un client `role:"display"` (un écran n'a pas de bouton).

- `{"type":"set","key":"mode","value":"AB"|"ABC"|"ABCD"|"DUEL"}`
- `{"type":"set","key":"duration","value":120}`
- `{"type":"set","key":"sound","value":true}`
- `{"type":"set","key":"duelStarter","value":"A"|"B"}`
- `{"type":"set","key":"switchSide"}` (pas de `value`)

- `{"type":"ping","t0":1234567890123}`
  `t0` est l'horloge locale du client (ms) au moment de l'envoi. Utilisé pour
  la synchronisation d'horloge (voir plus bas). Un client `display` en émet
  un toutes les 20-30 secondes environ, et plusieurs à la connexion pour
  affiner tout de suite son décalage.

## Serveur → client

- `{"type":"welcome","serverTimeMs":...,"state":{...}}`
  Envoyé juste après la connexion, avant tout `state` — reprend un instantané
  complet pour que le client s'initialise sans attendre le prochain tick.

- `{"type":"state", phase, mode, side, letters, duelStarter, duelStep,
   soundOn, totalDuration, nextABCDStart, segmentStartMs, segmentDurationMs,
   serverTimeMs}`
  Diffusé à tous les clients connectés à chaque tick significatif (changement
  de phase, ou toutes les ~100ms pendant une phase active — voir server.js
  pour le détail du débit choisi). `segmentStartMs` et `segmentDurationMs`
  sont exprimés en temps serveur (epoch ms) : c'est au client de les
  interpréter avec son propre décalage d'horloge pour afficher un compte à
  rebours qui ne dérive pas.

- `{"type":"audible","kind":"whistle"|"end"|"emergency","count":1,"atMs":...}`
  Signale qu'un signal sonore doit être joué. Le son lui-même (Web Audio)
  est généré localement par chaque écran — le serveur ne fait que dire
  *quand* et *combien de bips*, jamais le son en tant que tel.

- `{"type":"pong","t0":...,"serverTime":...}`
  Réponse à un `ping`. `t0` est ré-échoué tel quel ; `serverTime` est
  l'horloge du serveur au moment de la réponse.

## Synchronisation d'horloge (calcul côté client)

À la réception d'un `pong` :

```
t2 = Date.now()                          // réception, horloge locale
rtt = t2 - t0
offset = serverTime - (t0 + t2) / 2      // offset = tempsServeur - tempsLocal
```

Garder les 5 derniers échantillons, retenir celui au `rtt` le plus faible
(le plus fiable), et rafraîchir l'estimation toutes les 20-30 secondes pour
absorber une éventuelle dérive d'horloge locale.

Pour interpréter un horodatage serveur `T` reçu dans un message `state` :

```
T_local_equivalent = T - offset
remaining_s = (T_local_equivalent - Date.now()) / 1000
```
