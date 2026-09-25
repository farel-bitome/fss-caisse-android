# FSS-CAISSE TPE — version Android

Portage Android de FSS-CAISSE pour les terminaux de paiement (TPE) Sunmi et Senraise H10S,
en mode **client** (connexion au PC serveur existant) ou **autonome** (le TPE devient lui-même
le serveur, sans PC).

## Principe général

Le TPE réutilise **exactement** le même frontend web que la version bureau (`app/index.html`,
`network.js`, `auth.js`, `etab.js`...) et **exactement** le même serveur embarqué
(`embedded-server.js`), sans aucune modification de ces fichiers. Trois pièces font le lien :

1. **`android-bridge-source/android-bridge.js`** — recrée `window.electronAPI` (le même objet
   que `preload.js` sous Electron) à partir du pont natif. Injecté par le code natif sur
   *chaque* page chargée dans la WebView, qu'elle vienne du serveur embarqué local
   (`http://127.0.0.1:3000`) ou d'un serveur PC distant sur le réseau — pas seulement les pages
   du bundle de l'appli. C'est ce qui permet à `index.html`, `choice.html`, `client.html`,
   `server-ip.html` et `activation.html` de fonctionner sans la moindre modification.

2. **`android/app/src/main/java/com/fss/caisse/FssNativeBridge.java`** — implémente côté natif
   chaque méthode de `electronAPI` (choix du rôle, impression, sauvegardes...).

3. **`android/app/src/main/assets/www/nodejs-project/`** — copie du serveur embarqué
   (`embedded-server.js`, `server-data/`, `app/`) plus un petit `main.js` de démarrage, exécutée
   par un vrai runtime Node.js embarqué dans l'APK (`nodejs-mobile-cordova`) pour le **mode
   autonome**. Aucune dépendance native compilée (`express` + `socket.io` uniquement, installés
   avec `--omit=optional`) — c'est ce qui permet à Node de tourner sans recompilation pour
   l'architecture des TPE.

## Impression

Détection **universelle**, indépendante du texte `Build.MANUFACTURER`/`MODEL` (peu fiable sur les
nombreux clones/OEM en marque blanche) : `PrinterDriverFactory.java` interroge directement le
`PackageManager` pour voir quel service d'impression est réellement installé sur *cet* appareil,
et choisit le driver correspondant :

1. **Sunmi (toutes séries : V1/V1s, V2/V2 Pro/V2s, V3, P1/P1 4G, T1/T2/T2 mini/T2s, D2, S2...)** :
   fonctionnel. Utilise le service AIDL officiel et public `woyou.aidlservice.jiuiv5`, déjà présent
   en usine sur tous les appareils Sunmi (`android/app/src/main/aidl/woyou/...`, récupéré depuis
   le SDK public de Sunmi — aucune dépendance externe à télécharger).
2. **Senraise H10 / H10C / H10S / H10P (toutes séries)** : fonctionnel. Utilise le service
   embarqué `recieptservice.com.recieptservice`
   (`android/app/src/main/java/com/fss/caisse/printer/H10sPrinterDriver.java`), via l'interface
   AIDL `PrinterInterface` (source communautaire, licence BSD-3, dans
   `android/app/src/main/java/recieptservice/`) — le même mécanisme déjà validé dans FSS-CALCUL,
   projet sœur du même éditeur pour les mêmes familles de TPE.
3. **Secours universel** (`AndroidSystemPrinterDriver.java`) : si aucun des deux services
   ci-dessus n'est détecté (tablette Android générique, caisse d'une marque non reconnue, ou
   simplement TPE dont le service embarqué diffère), l'impression passe par le cadre système
   standard `android.print.PrintManager` — fonctionne sur n'importe quel appareil Android, mais
   n'est plus totalement silencieuse (boîte de dialogue système). `FssNativeBridge.doPrint()`
   bascule aussi automatiquement sur ce secours si le driver fabricant détecté échoue au moment
   d'imprimer (service installé mais pas encore lié, panne ponctuelle...), pour qu'aucun appareil
   ne se retrouve totalement sans moyen d'imprimer.

Le `<queries>` d'`AndroidManifest.xml` déclare les deux paquets de service (obligatoire depuis
Android 11 pour que `PackageManager` puisse seulement les voir).

Le rendu : le ticket HTML (identique à celui de la version bureau) est rendu dans une WebView
invisible puis converti en image, envoyée telle quelle à l'imprimante (`printer/HtmlToBitmap.java`
pour Sunmi/Senraise, directement en HTML pour le secours système). Ça évite de reprogrammer toute
la mise en page en commandes ESC/POS — tout changement visuel fait côté web (dans `index.html`)
s'applique aussi à l'impression TPE sans rien retoucher côté Android.

## Compiler

Ce bac à sable n'a pas accès au SDK/NDK Android ni à Google Maven — impossible d'y compiler
l'APK. La compilation se fait via **GitHub Actions**
(`.github/workflows/build-android.yml`), qui :
1. régénère `file.list`/`dir.list` (liste des fichiers de `nodejs-project` — nécessaire car le
   hook Cordova qui le fait normalement ne s'exécute pas sous Capacitor) ;
2. installe le NDK ;
3. compile un **APK debug** (sideload, à installer directement sur les TPE) ;
4. compile un **AAB release signé** (Play Store) si les secrets de signature sont configurés.

Pousser ce dépôt sur GitHub et lancer le workflow (`workflow_dispatch` ou push sur `main`)
suffit à obtenir l'APK dans l'onglet Actions → Artifacts.

### Signer pour le Play Store

```bash
keytool -genkey -v -keystore fss-release.keystore -alias fss-caisse \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 fss-release.keystore > keystore.b64
```

Puis, dans les secrets du dépôt GitHub (Settings → Secrets and variables → Actions) :
- `FSS_KEYSTORE_BASE64` : contenu de `keystore.b64`
- `FSS_KEYSTORE_PASSWORD`, `FSS_KEY_ALIAS`, `FSS_KEY_PASSWORD` : les valeurs choisies au moment
  du `keytool -genkey`

**Conserver ce keystore précieusement** — sans lui, impossible de publier une mise à jour de
l'appli déjà en ligne sur le Play Store (Google exige la même signature à chaque mise à jour).

## Développer en local (avec un Android Studio + SDK/NDK installés)

```bash
npm install
node scripts/generate-node-asset-lists.js   # après toute modif de www/nodejs-project ou node_modules
npx cap sync android
mkdir -p android/app/src/main/assets/nodejs-mobile-cordova-assets
cp -r node_modules/nodejs-mobile-cordova/install/nodejs-mobile-cordova-assets/. \
      android/app/src/main/assets/nodejs-mobile-cordova-assets/
node scripts/patch-nodejs-plugin-diagnostics.js
```

Puis ouvrir `android/` dans Android Studio.

⚠️ Après un `npx cap sync android`, le dossier `android/app/src/main/assets/www/nodejs-project`,
les fichiers `file.list`/`dir.list`, le dossier `nodejs-mobile-cordova-assets/` ET le patch de
`NodeJS.java` ne sont PAS gérés par Capacitor (voir "Panne résolue" plus bas pour le détail de
pourquoi ces trois dernières étapes sont nécessaires) : il faut relancer les quatre commandes
ci-dessus (dans cet ordre) après tout `npx cap sync android`. Le workflow GitHub Actions le fait
déjà automatiquement à chaque build.

## Pourquoi `nodejs-project` n'est pas dans `www/` malgré ce que dit la doc de nodejs-mobile-cordova

La doc historique du plugin (pensée pour Cordova pur) place `nodejs-project` dans
`www/nodejs-project`, copié tel quel dans les assets Android au dossier `www/`. Mais Capacitor
copie son propre contenu web vers `assets/public/`, pas `assets/www/` — donc placer
`nodejs-project` dans le `www/` **source** de Capacitor ne le fait PAS atterrir au bon endroit
dans l'APK. Pour éviter cette confusion, `nodejs-project` est géré séparément, directement à
l'emplacement natif attendu : `android/app/src/main/assets/www/nodejs-project/`.

## Rôles (mode client / autonome)

Reproduit le comportement de `main.js` (Electron) :
- Premier lancement → écran de choix (`choice.html`, inchangé)
- **Poste Client** → `client.html` (inchangé) enregistre l'IP du serveur PC, la WebView navigue
  dessus directement (HTTP simple, réseau local)
- **Ordinateur/TPE Serveur** (mode autonome) → démarre `nodejs-project/main.js` via
  `nodejs-mobile-cordova`, puis navigue sur `http://127.0.0.1:3000/`

## Licence

Chaque TPE a sa propre licence, avec le **même mécanisme** que la version bureau
(`android/app/src/main/java/com/fss/caisse/Licensing.java`, porté depuis `licensing.js`) :
même secret (`LICENSE_SECRET`), même algorithme (HMAC-SHA256, clé formatée en 4 groupes de 4
caractères), même essai de 3 jours, même blocage forcé sur `activation.html` une fois l'essai
expiré. Seul l'identifiant machine change de source : GUID Windows côté PC,
`Settings.Secure.ANDROID_ID` côté TPE.

⚠️ **Hypothèse à vérifier** : `licensing.js` mentionne qu'un générateur de clé "Android" existe
déjà dans l'écosystème FSS-CAISSE-SALON, mais je n'ai pas eu accès à son code. J'ai donc repris
l'identifiant Android le plus standard (`ANDROID_ID`) préfixé par `"ANDROIDID|"`, en miroir du
`"WINGUID|"` utilisé côté Windows. Si le générateur existant utilise une autre convention pour
calculer l'identifiant machine Android, les clés ne correspondront pas tant que la fonction
`getMachineId()` de `Licensing.java` n'est pas alignée dessus (changement d'une seule méthode).
Le plus sûr : générer une clé avec l'identifiant qu'affiche `activation.html` sur un TPE réel et
vérifier qu'elle correspond à ce que produirait le générateur existant.

## Fiabilité du mode autonome

Sans précaution particulière, Android peut tuer l'appli (et donc le serveur Node embarqué)
dès que l'écran s'éteint ou qu'elle passe en arrière-plan — inacceptable pour un TPE censé
servir en continu. Trois mesures ajoutées pour éviter ça :

- **Foreground service** (`FssServerService.java`), démarré automatiquement dès que le rôle
  "autonome" est actif. Une notification discrète et permanente ("Serveur de caisse actif")
  indique au système que l'appli rend un service actif — ça réduit très fortement le risque
  d'être tuée pour libérer de la mémoire.
- **Wake lock partiel** : garde le CPU réveillé même écran éteint, pour que les autres postes
  (clients Android/PC) puissent continuer à interroger le serveur sans latence.
- **Écran maintenu allumé** (`FLAG_KEEP_SCREEN_ON`) pendant l'utilisation de l'appli — cohérent
  avec un TPE affiché en continu au comptoir. L'appareil reste verrouillable manuellement.

Sur Android 13+, l'appli demande la permission de notification au premier lancement
(nécessaire pour afficher celle du foreground service).

Pour une fiabilité maximale sur le terrain, il est recommandé en plus d'exclure l'appli de
l'optimisation de batterie du fabricant (Réglages → Batterie → FSS-CAISSE TPE → Sans
restriction) — certains fabricants de TPE (dont Sunmi) ont leurs propres mécanismes
d'économie d'énergie agressifs qui ignorent parfois les APIs Android standard.

## Panne résolue : le mode autonome restait bloqué 20s sans jamais démarrer

Sur un TPE réel, `window.nodejs.start('main.js', ...)` ne renvoyait **ni succès ni erreur** — juste
le message générique "Le serveur embarqué ne répond pas après 20s.", avec un journal
(`startup.log`) introuvable et aucune extraction de `nodejs-project` sur le disque
(`/files` ne contenait que `trial.json`).

**Cause racine identifiée avec certitude** (en lisant directement le vrai code source de
`nodejs-mobile-cordova@0.4.3`, pas une supposition) : `NodeJS.java` (le plugin natif) commence
TOUJOURS sa procédure d'extraction (`copyNodeJSAssets()`) par copier un dossier d'assets propre au
plugin, `nodejs-mobile-cordova-assets/` (petits modules Node intégrés). Ce dossier n'est
normalement copié dans les assets Android que par le hook Cordova `before_plugin_install` du
plugin — un hook qui, comme celui de `file.list`/`dir.list` (déjà contourné par
`generate-node-asset-lists.js`), **ne s'exécute pas sous Capacitor** (`npx cap sync android` ne
lance pas le cycle de hooks complet de Cordova). Ce dossier était donc totalement absent de l'APK.

Quand `assetManager.list("nodejs-mobile-cordova-assets")` porte sur un dossier qui n'existe pas du
tout (pas juste vide), Android renvoie `null` plutôt qu'un tableau vide — et la ligne suivante du
plugin (`files.length == 0`) lève alors une `NullPointerException`. Cette exception n'est **pas**
une `IOException`, donc elle n'est rattrapée par aucun `catch` du plugin : le thread
d'initialisation meurt en silence, **avant même d'avoir libéré le verrou (`Semaphore`) que
`startEngine()` attend juste après** pour savoir si l'extraction a réussi. Résultat :
`startEngine()` reste bloqué indéfiniment sur ce verrou, sans jamais pouvoir appeler ni le
callback de succès ni celui d'échec — exactement le symptôme observé (silence total, jamais de
message précis, juste notre propre timeout générique de 20s côté JS).

**Corrections apportées** (`.github/workflows/build-android.yml` + `scripts/patch-nodejs-plugin-diagnostics.js`) :
1. Le dossier `nodejs-mobile-cordova-assets/` est maintenant copié depuis
   `node_modules/nodejs-mobile-cordova/install/` vers les assets Android à chaque build — élimine
   la cause racine.
2. Par sécurité pour tout souci équivalent non encore rencontré (autre dossier manquant sur un
   autre modèle de TPE, etc.), `scripts/patch-nodejs-plugin-diagnostics.js` patche automatiquement
   le `NodeJS.java` régénéré par `cap sync` (à chaque build, car ce fichier est régénéré à chaque
   fois) pour : rattraper *toute* exception (pas seulement `IOException`) autour de la copie des
   assets, **libérer le verrou dans un bloc `finally`** (plus jamais de blocage permanent, quelle
   qu'en soit la cause), et journaliser chaque étape (`pluginInitialize`, `asyncInit`,
   `copyNodeJSAssets`, `execute`) dans `<stockage interne>/fss-data/native-plugin.log` —
   consultable directement dans l'appli (le même écran de diagnostic qui affichait déjà
   `startup.log` affiche maintenant aussi ce journal natif, via
   `FssNativeBridge.getNativePluginLog()`), sans avoir besoin d'`adb` sur le TPE.

Si un souci de démarrage du mode autonome revient malgré ces correctifs, ce nouveau journal natif
dira précisément à quelle étape ça bloque, ce qui rendra le diagnostic immédiat au lieu de devoir
à nouveau remonter toute la chaîne d'appels.

## Deuxième panne résolue : "Cannot find module .../engine.io/build/engine.io.js"

Une fois la panne ci-dessus corrigée, Node démarrait enfin — mais `main.js` échouait aussitôt avec
une erreur Node authentique (remontée immédiatement via le canal `server-error`, donc **avant**
le timeout de 20s) : `Cannot find module '.../node_modules/engine.io/build/engine.io.js'`, alors
que ce fichier existe bel et bien sur le disque du TPE (extraction vérifiée réussie).

**Cause racine identifiée avec certitude** : `nodejs-mobile-cordova@0.4.3` embarque **Node.js
12.19.0** (vérifié directement dans le binaire natif du plugin :
`node_modules/nodejs-mobile-cordova/libs/android/libnode/include/node/node_version.h`). C'est un
Node ancien (fin 2020) dont la prise en charge du champ `"exports"` du `package.json`
(résolution conditionnelle de modules) est connue pour être incomplète sur les formes utilisées
par les dépendances modernes. `socket.io@4.7.5` → `engine.io@6.6.x` (et plusieurs de leurs propres
dépendances) déclarent un `"exports"` conditionnel (`"require"`/`"import"`/`"types"`) en plus de
`"main"` — les deux pointant vers exactement le même fichier — mais Node 12.19 échoue à résoudre
cette forme et rapporte le fichier introuvable, alors qu'une résolution classique via `"main"`
(seule, sans `"exports"`) fonctionne parfaitement sur ce même Node 12.19.

**Correction** : `scripts/fix-nodejs-project-node12-exports.js` supprime le champ `"exports"` de
chaque `package.json` de `nodejs-project/node_modules`, **uniquement** quand sa cible de
résolution `require`/`default` est identique à `"main"` (donc sans changer le fichier réellement
chargé — juste en évitant l'algorithme de résolution `"exports"` bogué sur ce Node précis). Déjà
appliqué aux dépendances actuellement commitées (18 paquets concernés : `engine.io`, `socket.io`,
`ws`, `engine.io-parser`, `socket.io-parser`, et leurs dépendances transitives comme
`side-channel*`/`get-intrinsic`/`call-bound`...). **À relancer après toute mise à jour des
dépendances de `nodejs-project`** (son `node_modules` est commité tel quel dans le dépôt et
embarqué directement dans l'APK — il n'y a pas de `npm install` pour lui en CI).

## Limites connues / à trancher

- **`openBackupFileDialog`** (restauration manuelle d'une sauvegarde) : pas de sélecteur de
  fichier branché pour l'instant (les TPE n'ont généralement pas d'explorateur pratique) —
  `listBackups`/`createBackup`/`readBackup` fonctionnent (stockage interne de l'appli).
- **Compilation non testée en conditions réelles** — je n'ai pas pu compiler/exécuter ce projet
  dans mon environnement (pas de SDK/NDK Android disponible). L'architecture et chaque pièce
  individuelle sont vérifiées contre la documentation/le code source réel des outils utilisés
  (Capacitor, nodejs-mobile-cordova, SDK Sunmi), mais un premier build sur GitHub Actions peut
  faire remonter des ajustements mineurs (versions de dépendances, chemins).
