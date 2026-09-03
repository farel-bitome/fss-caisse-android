// Point d'entrée Node.js côté mobile (nodejs-mobile-cordova).
// Démarre le même embedded-server.js que la version bureau, inchangé, avec :
//  - les données persistées dans un dossier SIBLING de nodejs-project (survit aux mises à
//    jour de l'appli, contrairement à nodejs-project lui-même qui est recopié à chaque install)
//  - le frontend (./app) et le catalogue par défaut (./server-data) embarqués tels quels
//
// Tout est enveloppé de façon défensive : la moindre erreur (y compris un simple require()
// qui échoue si un fichier ne s'est pas correctement copié dans l'APK) est remontée jusqu'à
// l'écran du TPE via le canal cordova.channel, plutôt que de faire échouer silencieusement le
// thread Node — ce qui, avant, ne laissait qu'un "ne répond pas" générique côté appli.

function report(event, payload) {
  try {
    if (typeof cordova !== 'undefined' && cordova.channel) {
      cordova.channel.post(event, payload);
    }
  } catch (e) {
    // Rien de plus à faire si même le canal de rapport échoue.
  }
}

// Filet de sécurité ultime : toute exception qui n'aurait été rattrapée nulle part ailleurs
// (erreur asynchrone dans Express/Socket.io, etc.) est quand même signalée avant que le
// processus ne s'arrête, au lieu de laisser le TPE dans un silence total.
process.on('uncaughtException', function (err) {
  report('server-error', { message: '[uncaughtException] ' + (err && err.stack ? err.stack : err) });
});

try {
  const path = require('path');
  const fs = require('fs');
  const startEmbeddedServer = require('./embedded-server');

  const PORT = 3000;
  const userDataDir = path.join(__dirname, '..', 'fss-data');
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  startEmbeddedServer(PORT, userDataDir, __dirname)
    .then(function () {
      console.log('[FSS-CAISSE] Serveur embarqué (mode autonome) démarré sur le port ' + PORT);
      report('server-ready', { port: PORT });
    })
    .catch(function (e) {
      console.error('[FSS-CAISSE] Échec du démarrage du serveur embarqué :', e && e.message);
      report('server-error', { message: (e && e.stack) ? e.stack : String(e) });
    });
} catch (e) {
  // Erreur survenue avant même d'atteindre la promesse ci-dessus (ex : un require() qui
  // échoue parce qu'un module n'a pas été correctement copié dans l'APK/les assets).
  console.error('[FSS-CAISSE] Erreur fatale au chargement de main.js :', e && e.message);
  report('server-error', { message: '[chargement] ' + ((e && e.stack) ? e.stack : String(e)) });
}
