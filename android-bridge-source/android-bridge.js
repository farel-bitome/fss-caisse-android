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

  // ---- Bandeau de statut flottant (diagnostic sans PC/ADB) --------------------------------
  function showStatus(text) {
    var el = document.getElementById('__fssStatusBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = '__fssStatusBanner';
      el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:999999;' +
        'background:#111;color:#fff;font:12px monospace;padding:8px 10px;' +
        'border-top:2px solid #CC0000;white-space:pre-wrap;max-height:40vh;overflow:auto;';
      document.body.appendChild(el);
    }
    el.textContent = text;
  }
  function hideStatus() {
    var el = document.getElementById('__fssStatusBanner');
    if (el) el.remove();
  }

  // ---- Démarrage/navigation, équivalent de boot()/showClientScreen() dans main.js (Electron) ----
  function pingServer(url, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var xhr = new XMLHttpRequest();
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { xhr.abort(); } catch (e) {}
        resolve(false);
      }, timeoutMs || 1500);
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4 && !done) {
          done = true;
          clearTimeout(timer);
          // N'importe quelle réponse HTTP (même une erreur applicative) prouve que quelque
          // chose écoute sur ce port — status 0 = pas de connexion du tout (serveur pas prêt).
          resolve(xhr.status > 0);
        }
      };
      try {
        xhr.open('GET', url, true);
        xhr.send();
      } catch (e) {
        done = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  function waitForServer(maxWaitMs) {
    var start = Date.now();
    function attempt() {
      return pingServer('http://127.0.0.1:3000/', 1500).then(function (ok) {
        if (ok) return true;
        if (Date.now() - start > maxWaitMs) return false;
        showStatus('Démarrage du serveur embarqué… (' + Math.round((Date.now() - start) / 1000) + 's)');
        return new Promise(function (r) { setTimeout(r, 500); }).then(attempt);
      });
    }
    return attempt();
  }

  function startEmbeddedServer() {
    return new Promise(function (resolve) {
      // Écoute les événements que main.js remonte depuis le côté Node (voir report() dans
      // nodejs-project/main.js) — permet d'afficher la VRAIE erreur immédiatement, au lieu
      // d'attendre un timeout générique de 20s qui ne dit pas pourquoi ça a échoué.
      if (window.nodejs && window.nodejs.channel && !window.__fssServerListenerSet) {
        window.__fssServerListenerSet = true;
        window.nodejs.channel.on('server-error', function (info) {
          window.__fssServerLastError = (info && info.message) ? info.message : String(info);
          showStatus('Erreur du serveur embarqué :\n' + window.__fssServerLastError);
        });
        window.nodejs.channel.on('server-ready', function () {
          window.__fssServerLastError = null;
        });
      }

      // nodejs-mobile-cordova ne supporte qu'un seul démarrage par processus applicatif —
      // sans ce garde-fou, revenir sur cette page (ex: après reloadApp() suite à une
      // activation de licence) tenterait de redémarrer Node et échouerait.
      if (window.__fssNodeStarted) {
        waitForServer(8000).then(function (ok) { if (ok) hideStatus(); resolve(ok); });
        return;
      }
      if (!(window.nodejs && window.nodejs.start)) {
        showStatus('Erreur : moteur Node.js embarqué indisponible (window.nodejs absent).\n' +
          'Le plugin nodejs-mobile-cordova ne semble pas chargé sur cet appareil/build.');
        resolve(false);
        return;
      }
      showStatus('Démarrage du serveur embarqué…');
      window.__fssNodeStarted = true;
      window.nodejs.start('main.js', function (err) {
        if (err) {
          window.__fssNodeStarted = false;
          showStatus('Erreur au démarrage de Node.js :\n' + err);
          resolve(false);
        }
      });
      // Démarre aussi le service au premier plan côté natif (voir FssServerService) pour que
      // le TPE continue à servir même écran éteint ou appli en arrière-plan.
      call('startServerService', {});
      // Attend activement que le serveur réponde réellement (jusqu'à 20s) plutôt qu'un délai
      // fixe arbitraire — le premier démarrage (extraction des assets, chargement des modules)
      // peut prendre plus d'une seconde selon l'appareil.
      waitForServer(20000).then(function (ok) {
        if (!ok) {
          // Si main.js a signalé une erreur précise entre-temps, elle est déjà affichée par
          // le listener ci-dessus — on ne l'écrase pas avec le message générique.
          if (!window.__fssServerLastError) {
            showStatus('Le serveur embarqué ne répond pas après 20s.\n' +
              'Vérifie que le TPE a assez d\'espace de stockage libre, puis relance l\'appli.\n' +
              'Si le problème persiste, ceci est le message à transmettre pour diagnostic.');
          }
        } else {
          hideStatus();
        }
        resolve(ok);
      });
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
        return startEmbeddedServer().then(function (ok) {
          if (ok) window.location.href = 'http://127.0.0.1:3000/';
          // Si ok=false, on reste sur cette page : le bandeau de statut affiche déjà
          // l'erreur — inutile de naviguer vers une URL qu'on sait cassée.
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
          return startEmbeddedServer().then(function (ok) {
            if (ok) window.location.href = 'http://127.0.0.1:3000/';
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
