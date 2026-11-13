// FSS-CAISSE — Session sécurisée : ajoute automatiquement le jeton de connexion à chaque appel /api/
// (le serveur refuse tout appareil non connecté). Le jeton reste en mémoire uniquement.
(function () {
  window.FSS_TOKEN = window.FSS_TOKEN || '';
  var dejaAffiche = false;
  function sessionExpiree() {
    if (dejaAffiche) return;
    dejaAffiche = true;
    try { if (typeof toast === 'function') toast('Session expirée — reconnexion...', 'e'); } catch (e) {}
    setTimeout(function () { location.reload(); }, 1500);
  }
  var original = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = '';
    try {
      url = typeof input === 'string' ? input : ((input && input.url) || '');
      var memeServeur = url.charAt(0) === '/' || url.indexOf(location.origin + '/') === 0;
      if (window.FSS_TOKEN && memeServeur && url.indexOf('/api/') !== -1) {
        init = init || {};
        var h = new Headers(init.headers || (typeof input !== 'string' && input && input.headers) || {});
        h.set('X-FSS-Token', window.FSS_TOKEN);
        init.headers = h;
      }
    } catch (e) {}
    return original(input, init).then(function (r) {
      try { if (r && r.status === 401 && window.FSS_TOKEN && url.indexOf('/api/') !== -1) sessionExpiree(); } catch (e) {}
      return r;
    });
  };
})();
