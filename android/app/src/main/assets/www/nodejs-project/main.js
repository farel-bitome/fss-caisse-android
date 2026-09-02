// Point d'entrée Node.js côté mobile (nodejs-mobile-cordova).
// Démarre le même embedded-server.js que la version bureau, inchangé, avec :
//  - les données persistées dans un dossier SIBLING de nodejs-project (survit aux mises à
//    jour de l'appli, contrairement à nodejs-project lui-même qui est recopié à chaque install)
//  - le frontend (./app) et le catalogue par défaut (./server-data) embarqués tels quels
const path = require('path');
const fs = require('fs');
const startEmbeddedServer = require('./embedded-server');

const PORT = 3000;
const userDataDir = path.join(__dirname, '..', 'fss-data');
if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

startEmbeddedServer(PORT, userDataDir, __dirname)
  .then(function () {
    console.log('[FSS-CAISSE] Serveur embarqué (mode autonome) démarré sur le port ' + PORT);
    if (typeof cordova !== 'undefined' && cordova.channel) {
      cordova.channel.post('server-ready', { port: PORT });
    }
  })
  .catch(function (e) {
    console.error('[FSS-CAISSE] Échec du démarrage du serveur embarqué :', e && e.message);
    if (typeof cordova !== 'undefined' && cordova.channel) {
      cordova.channel.post('server-error', { message: e && e.message });
    }
  });
