#!/usr/bin/env node
// Corrige un bug réel et vérifié de nodejs-mobile-cordova@0.4.3 sous Capacitor, et ajoute une
// journalisation native consultable depuis l'appli (sans adb) pour tout problème futur du même
// genre.
//
// ===================== Le bug (vérifié, pas une supposition) =====================
//
// NodeJS.java (le plugin natif) a un ordre d'opérations dans copyNodeJSAssets() qui commence
// TOUJOURS par :
//     copyFolder(BUILTIN_ASSETS);   // BUILTIN_ASSETS = "nodejs-mobile-cordova-assets"
// via copyAssetFolder(), qui fait :
//     String[] files = assetManager.list(srcFolder);
//     if (files.length == 0) { ... }
//
// Ce dossier "nodejs-mobile-cordova-assets" (modules Node natifs intégrés au plugin) vit dans
// node_modules/nodejs-mobile-cordova/install/nodejs-mobile-cordova-assets/ et n'est normalement
// copié dans les assets Android QUE par le hook Cordova "before_plugin_install" du plugin — hook
// qui, comme celui de file.list/dir.list (déjà contourné par generate-node-asset-lists.js), NE
// S'EXÉCUTE PAS sous "npx cap sync android". Résultat vérifié : ce dossier est totalement absent
// de android/app/src/main/assets/ dans ce projet.
//
// Quand le dossier n'existe PAS du tout dans les assets (pas juste vide), assetManager.list()
// renvoie null (comportement documenté d'Android) — pas un tableau vide. La ligne
// "if (files.length == 0)" lève alors une NullPointerException, qui N'EST PAS une IOException et
// n'est donc PAS rattrapée par le seul "catch (IOException e)" de copyNodeJSAssets(). Le thread
// d'initialisation meurt silencieusement (rien dans l'UI, rien sans adb) AVANT MÊME la ligne
// "initSemaphore.release()" — le sémaphore reste bloqué à zéro pour toujours. startEngine() (sur
// SON PROPRE thread) attend ce même sémaphore via waitForInit() : il attend donc indéfiniment,
// sans jamais appeler ni le callback de succès ni celui d'échec. C'est exactement le symptôme
// observé : ni "Initialization failed", ni "File not found", ni succès — un silence total jusqu'au
// timeout générique de 20s côté JS (voir android-bridge.js).
//
// ===================== La correction =====================
//
// 1) On copie enfin le dossier manquant (voir build-android.yml et les instructions README pour
//    le développement local) — élimine la cause racine.
// 2) Par sécurité pour tout autre souci du même genre (fabricant/AAPT particulier, autre dossier
//    manquant à l'avenir...), ce script patche le NodeJS.java régénéré par "cap sync" pour :
//      - rattraper TOUT Throwable (pas seulement IOException) autour de copyNodeJSAssets(),
//      - LIBÉRER le sémaphore dans un bloc finally (plus jamais de blocage permanent, quelle que
//        soit la cause de l'échec),
//      - journaliser chaque étape dans <filesDir>/fss-data/native-plugin.log, lisible depuis
//        l'appli via FssNativeBridge.getNativePluginLog() (voir android-bridge.js) — sans adb.
//
// À exécuter APRÈS "npx cap sync android" et AVANT la compilation Gradle (le fichier cible est
// régénéré à chaque sync, donc ce patch doit être ré-appliqué à chaque fois — déjà fait
// automatiquement par build-android.yml).

const fs = require('fs');
const path = require('path');

const TARGET = path.join(
  __dirname, '..', 'android', 'capacitor-cordova-android-plugins',
  'src', 'main', 'java', 'com', 'janeasystems', 'cdvnodejsmobile', 'NodeJS.java'
);

if (!fs.existsSync(TARGET)) {
  console.error('Introuvable : ' + TARGET + ' — as-tu bien lancé "npx cap sync android" avant ce script ?');
  process.exit(1);
}

let src = fs.readFileSync(TARGET, 'utf8');
const original = src;

function replaceOnce(from, to, label) {
  const count = src.split(from).length - 1;
  if (count !== 1) {
    throw new Error(
      'Ancrage "' + label + '" trouvé ' + count + ' fois (1 attendu) dans NodeJS.java — ' +
      'le code source du plugin a probablement changé de version ; ce script doit être révisé ' +
      'avant de continuer (pour ne pas patcher au mauvais endroit).'
    );
  }
  src = src.split(from).join(to);
}

function replaceAll(from, to, label, expectedCount) {
  const count = src.split(from).length - 1;
  if (count !== expectedCount) {
    throw new Error(
      'Ancrage "' + label + '" trouvé ' + count + ' fois (' + expectedCount + ' attendu) — ' +
      'le code source du plugin a probablement changé de version ; ce script doit être révisé.'
    );
  }
  src = src.split(from).join(to);
}

// 1) Ajoute le champ d'erreur générique + le helper de journalisation disque, juste après la
//    déclaration de la classe.
replaceOnce(
  'public class NodeJS extends CordovaPlugin {',
  'public class NodeJS extends CordovaPlugin {\n' +
  '\n' +
  '  // ===== Ajouté par scripts/patch-nodejs-plugin-diagnostics.js (FSS-CAISSE TPE) =====\n' +
  '  // Erreur générique d\'initialisation, complémentaire de "ioe" : capture aussi les erreurs\n' +
  '  // qui ne sont PAS des IOException (ex: NullPointerException si un dossier d\'assets attendu\n' +
  '  // par le plugin est absent), qui plantaient auparavant le thread d\'init en silence.\n' +
  '  private static Throwable fssInitError = null;\n' +
  '\n' +
  '  private static void fssDiagLog(String msg) {\n' +
  '    try {\n' +
  '      String base = (NodeJS.context != null)\n' +
  '          ? NodeJS.context.getFilesDir().getAbsolutePath()\n' +
  '          : (NodeJS.filesDir != null ? NodeJS.filesDir : null);\n' +
  '      if (base == null) return;\n' +
  '      java.io.File dir = new java.io.File(base + "/fss-data");\n' +
  '      if (!dir.exists()) dir.mkdirs();\n' +
  '      java.io.FileWriter fw = new java.io.FileWriter(new java.io.File(dir, "native-plugin.log"), true);\n' +
  '      fw.write("[" + new java.text.SimpleDateFormat("yyyy-MM-dd\'T\'HH:mm:ss.SSS").format(new java.util.Date())\n' +
  '          + "] " + msg + "\\n");\n' +
  '      fw.close();\n' +
  '    } catch (Throwable t) {\n' +
  '      // Ne jamais faire planter le plugin pour un souci de journalisation.\n' +
  '    }\n' +
  '  }\n' +
  '  // ===== Fin ajout =====\n',
  'déclaration de classe'
);

// 2) Trace le tout début de pluginInitialize(), dès que "context" est disponible.
replaceOnce(
  'filesDir = context.getFilesDir().getAbsolutePath();',
  'filesDir = context.getFilesDir().getAbsolutePath();\n' +
  '    fssDiagLog("pluginInitialize: demarre. filesDir=" + filesDir);',
  'début pluginInitialize'
);

// 3) Trace juste avant l'appel à asyncInit().
replaceOnce(
  '    asyncInit();\n  }',
  '    fssDiagLog("pluginInitialize: appel de asyncInit()...");\n    asyncInit();\n  }',
  'appel asyncInit'
);

// 4) Réécrit entièrement asyncInit() : journalisation à chaque étape, rattrape TOUT Throwable (pas
//    seulement IOException), et libère le sémaphore dans un bloc finally pour ne plus jamais
//    bloquer waitForInit() indéfiniment, quelle que soit la cause de l'échec.
const asyncInitOriginal =
  '  private void asyncInit() {\n' +
  '    if (wasAPKUpdated()) {\n' +
  '      try {\n' +
  '        initSemaphore.acquire();\n' +
  '        new Thread(new Runnable() {\n' +
  '          @Override\n' +
  '          public void run() {\n' +
  '            emptyTrash();\n' +
  '            try {\n' +
  '              copyNodeJSAssets();\n' +
  '              initCompleted = true;\n' +
  '            } catch (IOException e) {\n' +
  '              ioe = e;\n' +
  '              Log.e(LOGTAG, "Node assets copy failed: " + e.toString());\n' +
  '              e.printStackTrace();\n' +
  '            }\n' +
  '            initSemaphore.release();\n' +
  '            emptyTrash();\n' +
  '          }\n' +
  '        }).start();\n' +
  '      } catch (InterruptedException ie) {\n' +
  '        initSemaphore.release();\n' +
  '        ie.printStackTrace();\n' +
  '      }\n' +
  '    } else {\n' +
  '      initCompleted = true;\n' +
  '    }\n' +
  '  }';

const asyncInitPatched =
  '  private void asyncInit() {\n' +
  '    boolean apkUpdated = wasAPKUpdated();\n' +
  '    fssDiagLog("asyncInit: wasAPKUpdated=" + apkUpdated + " (previousLastUpdateTime=" + previousLastUpdateTime + ", lastUpdateTime=" + lastUpdateTime + ")");\n' +
  '    if (apkUpdated) {\n' +
  '      try {\n' +
  '        initSemaphore.acquire();\n' +
  '        fssDiagLog("asyncInit: semaphore acquis, demarrage du thread de copie des assets...");\n' +
  '        new Thread(new Runnable() {\n' +
  '          @Override\n' +
  '          public void run() {\n' +
  '            try {\n' +
  '              fssDiagLog("asyncInit/thread: demarre.");\n' +
  '              emptyTrash();\n' +
  '              try {\n' +
  '                fssDiagLog("asyncInit/thread: appel de copyNodeJSAssets()...");\n' +
  '                copyNodeJSAssets();\n' +
  '                initCompleted = true;\n' +
  '                fssDiagLog("asyncInit/thread: copyNodeJSAssets() reussi.");\n' +
  '              } catch (IOException e) {\n' +
  '                ioe = e;\n' +
  '                fssDiagLog("asyncInit/thread: ECHEC copyNodeJSAssets() (IOException) : " + e.toString());\n' +
  '                Log.e(LOGTAG, "Node assets copy failed: " + e.toString());\n' +
  '                e.printStackTrace();\n' +
  '              } catch (Throwable t) {\n' +
  '                // Avant ce correctif, une erreur ici (ex: NullPointerException si un dossier\n' +
  '                // d\'assets attendu par le plugin est absent) tuait ce thread SANS jamais\n' +
  '                // liberer le semaphore ci-dessous, bloquant startEngine() indefiniment sans\n' +
  '                // aucun message d\'erreur cote JS. On la rattrape maintenant explicitement.\n' +
  '                fssInitError = t;\n' +
  '                fssDiagLog("asyncInit/thread: ECHEC copyNodeJSAssets() (exception inattendue, non-IOException) : " + t);\n' +
  '                Log.e(LOGTAG, "Node assets copy failed (unexpected): " + t);\n' +
  '              }\n' +
  '              emptyTrash();\n' +
  '            } finally {\n' +
  '              // TOUJOURS libere le semaphore, quoi qu\'il arrive ci-dessus : plus jamais de\n' +
  '              // blocage permanent de waitForInit() a cause d\'une exception non prevue ici.\n' +
  '              initSemaphore.release();\n' +
  '              fssDiagLog("asyncInit/thread: termine (semaphore libere).");\n' +
  '            }\n' +
  '          }\n' +
  '        }).start();\n' +
  '      } catch (InterruptedException ie) {\n' +
  '        fssDiagLog("asyncInit: InterruptedException lors de l\'acquisition du semaphore : " + ie);\n' +
  '        initSemaphore.release();\n' +
  '        ie.printStackTrace();\n' +
  '      }\n' +
  '    } else {\n' +
  '      fssDiagLog("asyncInit: extraction ignoree (SharedPreferences indique un APK deja a jour).");\n' +
  '      initCompleted = true;\n' +
  '    }\n' +
  '  }';

replaceOnce(asyncInitOriginal, asyncInitPatched, 'corps de asyncInit()');

// 5) startEngine() / startEngineWithScript() : vérifie aussi fssInitError (pas seulement ioe), et
//    journalise l'entrée dans execute() pour confirmer, hors de tout doute, que l'appel JS
//    atteint bien le natif.
replaceAll(
  '        if (ioe != null) {\n' +
  '          sendResult(false, "Initialization failed: " + ioe.toString(), callbackContext);\n' +
  '          return;\n' +
  '        }',
  '        fssDiagLog("startEngine*: waitForInit() termine (ioe=" + ioe + ", fssInitError=" + fssInitError + ").");\n' +
  '        if (ioe != null) {\n' +
  '          sendResult(false, "Initialization failed: " + ioe.toString(), callbackContext);\n' +
  '          return;\n' +
  '        }\n' +
  '        if (fssInitError != null) {\n' +
  '          sendResult(false, "Initialization failed (unexpected): " + fssInitError.toString(), callbackContext);\n' +
  '          return;\n' +
  '        }',
  'vérification ioe dans startEngine*',
  2
);

replaceOnce(
  '  public boolean execute(String action, JSONArray data, CallbackContext callbackContext) throws JSONException {\n' +
  '    if (action.equals("sendMessageToNode")) {',
  '  public boolean execute(String action, JSONArray data, CallbackContext callbackContext) throws JSONException {\n' +
  '    fssDiagLog("execute: action=" + action);\n' +
  '    if (action.equals("sendMessageToNode")) {',
  'entrée de execute()'
);

// 6) copyNodeJSAssets() : journalise EXPLICITEMENT si la copie utilise file.list/dir.list (rapide,
//    fiable) ou retombe sur l'énumération directe des assets Android via assetManager.list()
//    (lente, et documentée comme peu fiable sur les arbres avec beaucoup de fichiers — c'est
//    justement pour l'éviter que scripts/generate-node-asset-lists.js existe). Si file.list est
//    illisible ou vide au runtime pour une raison quelconque, ce log le dira sans ambiguïté,
//    plutôt que de laisser deviner pourquoi certains fichiers copiés "avec succès" manquent
//    ensuite à l'appel pour Node (ex: node_modules/engine.io/build/engine.io.js).
replaceOnce(
  '    // Load the nodejs project\'s folders and files lists\n' +
  '    ArrayList<String> dirs = readFileFromAssets("dir.list");\n' +
  '    ArrayList<String> files = readFileFromAssets("file.list");\n' +
  '\n' +
  '    // Copy the node project files to the project working folder\n' +
  '    if (files.size() > 0) {\n' +
  '      Log.d(LOGTAG, "Copying node project assets using the files list");\n' +
  '\n' +
  '      for (String dir : dirs) {\n' +
  '        new File(NodeJS.filesDir + "/" + dir).mkdirs();\n' +
  '      }\n' +
  '\n' +
  '      for (String file : files) {\n' +
  '        String src = file;\n' +
  '        String dest = NodeJS.filesDir + "/" + file;\n' +
  '        NodeJS.copyAssetFile(src, dest);\n' +
  '      }\n' +
  '    } else {\n' +
  '      Log.d(LOGTAG, "Copying node project assets enumerating the APK assets folder");\n' +
  '      copyFolder(PROJECT_ROOT);\n' +
  '    }',
  '    // Load the nodejs project\'s folders and files lists\n' +
  '    ArrayList<String> dirs = readFileFromAssets("dir.list");\n' +
  '    ArrayList<String> files = readFileFromAssets("file.list");\n' +
  '    fssDiagLog("copyNodeJSAssets: dir.list=" + dirs.size() + " entrees, file.list=" + files.size() + " entrees.");\n' +
  '\n' +
  '    // Copy the node project files to the project working folder\n' +
  '    if (files.size() > 0) {\n' +
  '      fssDiagLog("copyNodeJSAssets: copie via file.list/dir.list (chemin fiable).");\n' +
  '      Log.d(LOGTAG, "Copying node project assets using the files list");\n' +
  '\n' +
  '      for (String dir : dirs) {\n' +
  '        new File(NodeJS.filesDir + "/" + dir).mkdirs();\n' +
  '      }\n' +
  '\n' +
  '      int fssCopyErrors = 0;\n' +
  '      IOException fssFirstCopyError = null;\n' +
  '      for (String file : files) {\n' +
  '        String src = file;\n' +
  '        String dest = NodeJS.filesDir + "/" + file;\n' +
  '        try {\n' +
  '          NodeJS.copyAssetFile(src, dest);\n' +
  '        } catch (IOException copyErr) {\n' +
  '          // Avant ce correctif, une SEULE IOException ici interrompait toute la boucle (donc\n' +
  '          // toute la copie) sans dire quels autres fichiers posaient aussi probleme. On\n' +
  '          // journalise CHAQUE fichier fautif et on continue la boucle jusqu\'au bout, pour\n' +
  '          // avoir la liste complete en un seul essai au lieu de decouvrir les echecs un par\n' +
  '          // un a chaque nouveau build. L\'erreur (la premiere rencontree) est quand meme\n' +
  '          // relevee a la fin, une fois la boucle terminee, pour ne pas masquer un vrai echec.\n' +
  '          fssCopyErrors++;\n' +
  '          fssDiagLog("copyNodeJSAssets: ECHEC copie de \'" + file + "\' : " + copyErr);\n' +
  '          if (fssFirstCopyError == null) fssFirstCopyError = copyErr;\n' +
  '        }\n' +
  '      }\n' +
  '      fssDiagLog("copyNodeJSAssets: copie terminee via file.list (" + files.size() + " fichiers, " + fssCopyErrors + " echec(s)).");\n' +
  '      if (fssFirstCopyError != null) {\n' +
  '        throw fssFirstCopyError;\n' +
  '      }\n' +
  '      // Verification cible, immediatement apres la copie : le fichier qui posait probleme\n' +
  '      // (engine.io/build/engine.io.js) existe-t-il reellement sur le disque a cet instant,\n' +
  '      // et avec quelle taille ? Reponse directe, sans avoir a deviner.\n' +
  '      File fssCheck = new File(NodeJS.filesDir + "/" + PROJECT_ROOT + "/node_modules/engine.io/build/engine.io.js");\n' +
  '      fssDiagLog("copyNodeJSAssets: verification engine.io/build/engine.io.js -> existe=" + fssCheck.exists() + ", taille=" + (fssCheck.exists() ? fssCheck.length() : -1));\n' +
  '    } else {\n' +
  '      fssDiagLog("copyNodeJSAssets: file.list VIDE OU ILLISIBLE -> repli sur l\'enumeration directe des assets (assetManager.list), connue pour etre peu fiable sur les arbres avec beaucoup de fichiers.");\n' +
  '      Log.d(LOGTAG, "Copying node project assets enumerating the APK assets folder");\n' +
  '      copyFolder(PROJECT_ROOT);\n' +
  '    }',
  'corps copie file.list/dir.list de copyNodeJSAssets()'
);

if (src === original) {
  throw new Error('Aucune modification appliquée — vérifier les ancrages.');
}

fs.writeFileSync(TARGET, src, 'utf8');
console.log('NodeJS.java patché avec succès (' + TARGET + ').');
