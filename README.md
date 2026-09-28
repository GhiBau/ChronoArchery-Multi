# ChronoArchery Multi (prototype)

Ce dépôt contient le premier prototype fonctionnel de la version "évoluée"
de [ChronoArchery](https://github.com/ghibau/chronoarchery) (la page solo,
inchangée, reste sur son propre dépôt) : un poste **maître** (un téléphone
pilote la séquence) et un ou plusieurs postes **écran** (affichage
synchronisé, sur Raspberry Pi ou vieux PC/portable), reliés par un réseau
WiFi local fermé, sans aucune dépendance à Internet en fonctionnement.

Tout ce qui est décrit ici a été **réellement testé** dans cette session
(machine à états, serveur, pages web dans un vrai navigateur, logique de
choix de rôle, scripts d'installation) — sauf la partie strictement
matérielle (WiFi en mode point d'accès, hostapd, dnsmasq, wpa_supplicant),
qui ne peut être vérifiée que sur un vrai poste. Voir « À vérifier avant de
déployer » plus bas.

## Structure du dépôt

```
app/            L'application web : display.html (écran), controller.html
                (télécommande), chrono-net.js (connexion réseau + audio
                partagés), index.html (page solo d'origine, inchangée).
server/         Le serveur maître : chrono-core.js (moteur de chrono, portage
                Node du index.html d'origine), server.js (HTTP + WebSocket),
                protocol.md (spécification des messages échangés).
node-agent/     L'agent de démarrage : agent.js (choix du rôle à chaque
                boot, voir plus bas), lib/ (config, identifiants réseau,
                pilotage réseau, QR codes), views/chooser.html (écran de
                configuration affiché au démarrage).
scripts/        Scripts système : réseau (net-*.sh), lancement kiosque
                (kiosk-launch.sh), mise à jour (update-check.sh),
                installation (install.sh).
systemd/        Les deux unités systemd (kiosque + serveur maître).
preseed/        preseed.cfg pour une installation Debian automatisée.
```

## Comment tout s'articule (résumé de la conception)

- **Un seul rôle choisi à CHAQUE démarrage**, jamais figé : `agent.js`
  tourne avant tout le reste, affiche la dernière configuration connue avec
  un compte à rebours, et laisse un téléphone la changer via un QR code —
  à chaque redémarrage, pas seulement à la première installation.
- **Aucun mot de passe WiFi ne circule** : chaque poste sait recalculer
  lui-même le SSID et le mot de passe du réseau ChronoArchery à partir d'un
  simple identifiant texte (ex. `blabla_54`) — voir `node-agent/lib/netid.js`.
- **Le serveur fait autorité**, jamais un onglet de navigateur : la
  machine à états tourne dans `server/chrono-core.js` (Node), supervisée par
  systemd (`Restart=always`) — un écran qui plante ou se recharge ne perd
  jamais la synchro.
- **La mise à jour ne se fait qu'à un seul moment** : au tout début du
  démarrage, avant que le réseau ne soit reconfiguré et avant qu'un écran ne
  soit affiché — jamais en cours de séance.
- **L'OS reste un Debian/Raspberry Pi OS standard, non modifié** : tout ce
  qui est spécifique à ChronoArchery vit dans `/opt/chronoarchery` et deux
  fichiers systemd, déployés par `install.sh`.

## Tester dès maintenant, sans matériel spécifique

Toute la partie logicielle (hors WiFi) tourne sur n'importe quelle machine
avec Node.js ≥ 18 :

```bash
# 1. Le serveur maître
cd server && npm install && node server.js
# 2. Dans un navigateur : http://localhost:8090/display.html
#    Dans un autre onglet : http://localhost:8090/controller.html
```

Vous pilotez la télécommande dans un onglet et voyez l'écran se synchroniser
dans l'autre — exactement le comportement attendu une fois déployé sur du
vrai matériel, à ceci près qu'ici les deux tournent sur la même machine au
lieu d'un maître + un écran séparés sur le réseau WiFi ChronoArchery.

Chaque brique a aussi ses propres tests automatisés (déjà exécutés, tous
verts, pendant la construction de ce prototype) :

```bash
node server/chrono-core.selftest.js       # machine à états
node server/server.smoketest.js           # serveur + WebSocket
node server/browser.smoketest.js          # bout-en-bout dans un vrai Chromium (nécessite Playwright)
node node-agent/lib.selftest.js           # config + identifiants réseau
node node-agent/agent.selftest.js         # logique de choix de rôle
```

## Installer sur un vieux PC portable (aujourd'hui, en test)

Comme il n'y a pas encore de dépôt public à télécharger, la voie la plus
simple pour un premier essai réel est :

1. Installer un Debian standard (netinst) sur le portable — à la main, ou en
   utilisant `preseed/preseed.cfg` pour aller plus vite (voir le fichier
   pour le paramètre de démarrage à ajouter ; il faut héberger ce fichier
   sur un petit serveur HTTP accessible depuis le portable pendant
   l'installation, par exemple `python3 -m http.server` sur un autre
   ordinateur du même réseau).
2. Une fois Debian démarré (avec un accès réseau normal), copier ce dossier
   sur le portable (clé USB, `scp`, etc.).
3. Lancer :
   ```bash
   sudo bash scripts/install.sh --source-dir /chemin/vers/chronoarchery-multi
   ```
4. Redémarrer. Le poste doit démarrer directement en mode kiosque et
   afficher l'écran de configuration (QR code) puisqu'aucun rôle n'est
   encore connu.

Plus tard, une fois le projet publié sur un vrai dépôt GitHub, `install.sh`
et `update-check.sh` sauront aller chercher les mises à jour tout seuls
(`--repo-tarball-url`, voir `etc/chronoarchery/update-source.conf` généré à
l'installation) — pas besoin de refaire cette étape manuelle à chaque fois.

## À vérifier avant de déployer pour de bon

Ce que cette session n'a **pas** pu tester faute de matériel WiFi réel :

- **Le mode point d'accès (AP) de la carte WiFi du portable.** Toutes les
  cartes ne le supportent pas, notamment sur du matériel ancien.
  `scripts/lib-common.sh` (fonction `check_ap_capable`) vérifie ce support
  au démarrage et s'arrête proprement sinon plutôt que d'échouer de façon
  confuse — mais à vérifier vous-même avant d'investir du temps :
  ```bash
  iw phy phy0 info | grep -A 10 "Supported interface modes"
  # Cherchez "* AP" dans la liste.
  ```
- **Le nom du paquet `chromium`** sur votre version de Debian précise
  (`apt-cache policy chromium` après l'installation de base).
- **Le recouvrement de la synchronisation d'horloge en conditions réelles**
  (latence WiFi réelle plutôt que loopback local) — le mécanisme est
  fonctionnellement validé (tests bout-en-bout ci-dessus), mais sa précision
  en millisecondes sur un vrai réseau reste à observer sur le terrain.
- **`startx` lancé depuis systemd** (plutôt que depuis un shell interactif) :
  la configuration de `chronoarchery-kiosk.service` suit une recette connue,
  mais chaque distribution a ses particularités (droits sur `/dev/tty1`,
  `PAM`) qu'il faut valider au premier boot réel.

## Limites connues / pistes pour la suite

- Le mode haute visibilité (`hv`) de `display.html` est un réglage fixe par
  écran (`?hv=1` dans l'URL), pas un bouton en direct depuis la télécommande
  — voir la note dans `app/display.html`.
- Un poste déjà en fonctionnement (écran ou maître) ne peut pas être
  reconfiguré sans redémarrage complet — cohérent avec la demande initiale
  (« à chaque démarrage »), mais une reconfiguration à chaud pourrait être
  ajoutée plus tard si besoin.
- L'élection automatique d'un maître (sans rôle pré-assigné à la
  configuration) n'est pas implémentée — chaque poste redemande son rôle à
  chaque démarrage, mais c'est toujours un geste humain (scan du QR ou
  reprise de la dernière config) qui tranche, jamais une élection
  automatique entre postes.
- `chrono-core.js` (serveur) est un portage manuel du moteur de
  `chronoarchery/index.html`, pas un module partagé — un futur
  rapprochement des deux implémentations éviterait la double maintenance en
  cas d'évolution des règles de chronométrage (voir le commentaire en tête
  de `server/chrono-core.js`).
