// Point d'entrée Node.js côté mobile (nodejs-mobile-cordova).
// Démarre le même embedded-server.js que la version bureau, inchangé, avec :
//  - les données persistées dans un dossier SIBLING de nodejs-project (survit aux mises à
//    jour de l'appli, contrairement à nodejs-project lui-même qui est recopié à chaque install)
//  - le frontend (./app) et le catalogue par défaut (./server-data) embarqués tels quels
//
// DIAGNOSTIC : ce fichier écrit un journal texte (startup.log) directement sur le disque, à
// CHAQUE étape, avant même de charger le moindre module tiers (y compris cordova-bridge). Ce
// journal ne dépend d'aucun canal de communication avec l'appli — donc il reste lisible (via
// FssNativeBridge.getStartupLog / le bandeau de diagnostic) même si :
//   - le module natif cordova-bridge ne fonctionne pas ou fait planter le process avant que le
//     moindre JS ne s'exécute,
//   - le thread Node s'arrête brutalement (crash natif) sans qu'aucune exception JS ne soit
//     levée,
//   - express/socket.io échouent au chargement.
// Avant cette version, seul cordova.channel.post() remontait les erreurs : si CE canal-là était
// cassé (ou si le process n'atteignait jamais ce point), on se retrouvait avec un "ne répond
// pas après 20s" totalement muet sur la vraie cause — exactement ce qui était observé.

var fs = require('fs');
var path = require('path');

var DATA_DIR = path.join(__dirname, '..', 'fss-data');
var LOG_FILE = path.join(DATA_DIR, 'startup.log');

function log(line) {
  var stamped = '[' + new Date().toISOString() + '] ' + line;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, stamped + '\n');
  } catch (e) {
    // Rien de plus à faire si même l'écriture sur disque échoue.
  }
  try { console.log('[FSS-CAISSE][startup] ' + line); } catch (e) {}
}

// Réinitialise le journal à CHAQUE démarrage (plutôt que d'accumuler indéfiniment d'un boot à
// l'autre), et prouve tout de suite que main.js a bien été atteint et exécuté par le moteur
// Node embarqué — c'est la toute première chose que ce fichier fait, avant tout require tiers.
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE,
    '[' + new Date().toISOString() + '] main.js démarré. __dirname=' + __dirname +
    ' | node=' + process.version + ' | platform=' + process.platform + '\n');
} catch (e) {
  // Si même ça échoue, il n'y a plus rien à journaliser sur disque — le process continue quand
  // même, au cas où le canal cordova-bridge, lui, fonctionne.
}

log('Étape 1/5 : fs/path chargés.');

var cordova = null;
try {
  // IMPORTANT : contrairement à ce qu'on pourrait croire, "cordova" n'est PAS une variable
  // globale automatiquement disponible dans ce contexte Node.js — c'est un module natif à
  // importer explicitement.
  cordova = require('cordova-bridge');
  log('Étape 2/5 : module cordova-bridge chargé avec succès.');
} catch (e) {
  log('Étape 2/5 : ÉCHEC du chargement de cordova-bridge : ' + ((e && e.stack) ? e.stack : e));
}

function report(event, payload) {
  log('Événement envoyé au canal cordova-bridge : ' + event + ' ' + JSON.stringify(payload));
  try {
    if (cordova && cordova.channel) {
      cordova.channel.post(event, payload);
    }
  } catch (e) {
    log('Échec de l\'envoi sur le canal cordova-bridge : ' + ((e && e.stack) ? e.stack : e));
  }
}

process.on('uncaughtException', function (err) {
  var msg = '[uncaughtException] ' + (err && err.stack ? err.stack : err);
  log(msg);
  report('server-error', { message: msg });
});

try {
  log('Étape 3/5 : chargement de embedded-server.js…');
  var startEmbeddedServer = require('./embedded-server');
  log('Étape 3/5 : embedded-server.js chargé avec succès.');

  var PORT = 3000;
  var userDataDir = DATA_DIR;

  log('Étape 4/5 : appel de startEmbeddedServer(port=' + PORT + ', userDataDir=' + userDataDir + ')…');

  startEmbeddedServer(PORT, userDataDir, __dirname)
    .then(function () {
      log('Étape 5/5 : serveur embarqué démarré avec succès sur le port ' + PORT + '.');
      report('server-ready', { port: PORT });
    })
    .catch(function (e) {
      var msg = (e && e.stack) ? e.stack : String(e);
      log('Étape 5/5 : ÉCHEC du démarrage du serveur embarqué : ' + msg);
      report('server-error', { message: msg });
    });
} catch (e) {
  var msg = '[chargement] ' + ((e && e.stack) ? e.stack : String(e));
  log(msg);
  report('server-error', { message: msg });
}
