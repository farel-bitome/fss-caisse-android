// FSS-CAISSE — Service worker minimal (installabilité PWA uniquement)
// Les données restent toujours en direct depuis le serveur : pas de cache hors-ligne
// pour éviter d'afficher des informations de caisse obsolètes.
self.addEventListener('install', function (e) {
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  self.clients.claim();
});
self.addEventListener('fetch', function (e) {
  // Passthrough réseau : toujours aller chercher la version la plus récente
  e.respondWith(fetch(e.request));
});
