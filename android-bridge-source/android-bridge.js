// FSS-CAISSE TPE — pont Android.
// Injecté directement par MainActivity.java (evaluateJavascript) au tout début de chaque page,
// qu'elle vienne du serveur embarqué local (mode autonome) ou d'un serveur PC distant (mode
// client) — comme preload.js d'Electron reste actif quelle que soit l'URL chargée dans la
// fenêtre. Objectif : index.html, choice.html, client.html, server-ip.html et activation.html
// fonctionnent SANS AUCUNE modification, sur la version bureau (Electron) comme sur un TPE
// Android.
(function () {
  if (window.electronAPI) return; // Déjà présent (vraie build Electron) — ne rien écraser.
  if (!window.FssNativeBridge) return; // Pas dans notre wrapper Android — page web normale.

  var callbacks = {};
  var seq = 0;
  window.__fssCallback = function (id, jsonResult) {
    var cb = callbacks[id];
    delete callbacks[id];
    if (cb) {
      try { cb(jsonResult ? JSON.parse(jsonResult) : null); }
      catch (e) { cb(null); }
    }
  };

  function call(method, argsObj) {
    return new Promise(function (resolve) {
      var id = 'cb' + (seq++);
      callbacks[id] = resolve;
      try {
        window.FssNativeBridge.invoke(method, JSON.stringify(argsObj || {}), id);
      } catch (e) {
        delete callbacks[id];
        resolve({ success: false, error: 'Pont natif indisponible : ' + e });
      }
    });
  }

  // ---- Démarrage/navigation, équivalent de boot()/showClientScreen() dans main.js (Electron) ----
  function startEmbeddedServer() {
    return new Promise(function (resolve) {
      // nodejs-mobile-cordova ne supporte qu'un seul démarrage par processus applicatif —
      // sans ce garde-fou, revenir sur cette page (ex: après reloadApp() suite à une
      // activation de licence) tenterait de redémarrer Node et échouerait.
      if (window.__fssNodeStarted) {
        resolve(true);
        return;
      }
      if (!(window.nodejs && window.nodejs.start)) {
        resolve(false);
        return;
      }
      window.__fssNodeStarted = true;
      window.nodejs.start('main.js', function (err) {
        if (err) { window.__fssNodeStarted = false; resolve(false); return; }
      });
      // Démarre aussi le service au premier plan côté natif (voir FssServerService) pour que
      // le TPE continue à servir même écran éteint ou appli en arrière-plan.
      call('startServerService', {});
      // Laisse le temps à Express de commencer à écouter avant de naviguer dessus.
      setTimeout(function () { resolve(true); }, 1200);
    });
  }

  window.__fssBoot = function () {
    return call('getBootConfig', {}).then(function (cfg) {
      cfg = cfg || {};
      // Même logique que boot() côté bureau (main.js) : licence bloquée -> écran d'activation
      // avant toute autre chose, quel que soit le rôle déjà choisi.
      if (cfg.blocked) {
        window.location.href = 'activation.html';
        return;
      }
      if (!cfg.role) {
        window.location.href = 'choice.html';
      } else if (cfg.role === 'server') {
        return startEmbeddedServer().then(function () {
          window.location.href = 'http://127.0.0.1:3000/';
        });
      } else if (cfg.role === 'client' && cfg.serverUrl) {
        window.location.href = cfg.serverUrl;
      } else {
        window.location.href = 'choice.html';
      }
    });
  };

  window.electronAPI = {
    chooseRole: function (role) {
      return call('chooseRole', { role: role }).then(function (result) {
        if (role === 'server') {
          return startEmbeddedServer().then(function () {
            window.location.href = 'http://127.0.0.1:3000/';
            return result;
          });
        }
        window.location.href = 'client.html';
        return result;
      });
    },
    saveServer: function (ip, port) {
      return call('saveServer', { ip: ip, port: port }).then(function (result) {
        window.location.href = 'http://' + ip + ':' + (port || 3000) + '/';
        return result;
      });
    },
    getCurrentServer: function () { return call('getCurrentServer', {}).then(function (r) { return r && r.url; }); },
    printSilent: function (html) { return call('printSilent', { html: html }); },
    getServerIpInfo: function () { return call('getServerIpInfo', {}); },
    saveManualIp: function (ip, port) { return call('saveManualIp', { ip: ip, port: port }); },
    resetManualIp: function () { return call('resetManualIp', {}); },
    reloadApp: function () { return window.__fssBoot(); },
    getMachineId: function () { return call('getMachineId', {}).then(function (r) { return r && r.id; }); },
    isLicensed: function () { return call('isLicensed', {}).then(function (r) { return !!(r && r.licensed); }); },
    activateLicense: function (key) { return call('activateLicense', { key: key }); },
    getTrialStatus: function () { return call('getTrialStatus', {}); },
    saveFileDialog: function (defaultName, content, isBase64) {
      return call('saveFileDialog', { defaultName: defaultName, content: content, isBase64: !!isBase64 });
    },
    listBackups: function () { return call('listBackups', {}); },
    createBackup: function (stateJson, type) { return call('createBackup', { stateJson: stateJson, type: type }); },
    readBackup: function (filename) { return call('readBackup', { filename: filename }); },
    openBackupFileDialog: function () { return call('openBackupFileDialog', {}); },
    // Pas d'équivalent "fermeture de fenêtre" pertinent sur mobile (l'OS gère le cycle de vie) —
    // no-op pour ne jamais faire planter network.js.
    onFlushAvantFermeture: function (cb) { window.__fssFlushCallback = cb; },
    confirmerFlushTermine: function () { return Promise.resolve(true); }
  };
})();
