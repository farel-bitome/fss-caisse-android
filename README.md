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

- **Sunmi (toutes séries)** : fonctionnel. Utilise le service AIDL officiel et public
  `woyou.aidlservice.jiuiv5`, déjà présent en usine sur tous les appareils Sunmi
  (`android/app/src/main/aidl/woyou/...`, récupéré depuis le SDK public de Sunmi — aucune
  dépendance externe à télécharger).
- **Senraise H10S (toutes séries)** : **squelette non fonctionnel**
  (`android/app/src/main/java/com/fss/caisse/printer/H10sPrinterDriver.java`). Senraise ne
  publie pas son SDK imprimante publiquement (leur fiche produit mentionne un "SDK gratuit sur
  demande"). Une fois ce SDK obtenu auprès de leur support, suivre les instructions en tête de
  ce fichier pour le brancher — la détection du modèle (`PrinterDriverFactory.java`) route déjà
  automatiquement les appareils Sunmi vers leur driver et tout le reste (H10S y compris) vers
  celui-ci.
- Le rendu : le ticket HTML (identique à celui de la version bureau) est rendu dans une WebView
  invisible puis converti en image, envoyée telle quelle à l'imprimante
  (`printer/HtmlToBitmap.java`). Ça évite de reprogrammer toute la mise en page en commandes
  ESC/POS — tout changement visuel fait côté web (dans `index.html`) s'applique aussi à
  l'impression TPE sans rien retoucher côté Android.

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
```

Puis ouvrir `android/` dans Android Studio.

⚠️ Après un `npx cap sync android`, le dossier `android/app/src/main/assets/www/nodejs-project`
et les fichiers `file.list`/`dir.list` ne sont PAS gérés par Capacitor (ils vivent en dehors de
`www/`, volontairement — voir plus bas) : ils survivent au sync mais il faut relancer
`node scripts/generate-node-asset-lists.js` après toute modification du contenu de
`nodejs-project`.

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

## Limites connues / à trancher

- **`openBackupFileDialog`** (restauration manuelle d'une sauvegarde) : pas de sélecteur de
  fichier branché pour l'instant (les TPE n'ont généralement pas d'explorateur pratique) —
  `listBackups`/`createBackup`/`readBackup` fonctionnent (stockage interne de l'appli).
- **Compilation non testée en conditions réelles** — je n'ai pas pu compiler/exécuter ce projet
  dans mon environnement (pas de SDK/NDK Android disponible). L'architecture et chaque pièce
  individuelle sont vérifiées contre la documentation/le code source réel des outils utilisés
  (Capacitor, nodejs-mobile-cordova, SDK Sunmi), mais un premier build sur GitHub Actions peut
  faire remonter des ajustements mineurs (versions de dépendances, chemins).
