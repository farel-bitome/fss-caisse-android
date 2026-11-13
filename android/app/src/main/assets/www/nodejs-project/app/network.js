// FSS-CAISSE — Synchronisation réseau (multi-postes)
// Ce script connecte l'application au serveur central FSS-CAISSE
// et synchronise en temps réel les données entre tous les postes.
(function () {
  var socket = (typeof io === 'function') ? io({ auth: function (cb) { cb({ token: window.FSS_TOKEN || '' }); } }) : null;
  var API = '/api/state';
  var applying = false;
  // Empêche tout envoi vers le serveur (syncPush) tant que ce poste n'a pas
  // reçu au moins une fois les vraies données du serveur. Sans ce verrou, un
  // poste client pouvait — dans une petite fenêtre au tout premier chargement,
  // surtout si le réseau est un peu lent — renvoyer ses données locales par
  // défaut (celles intégrées dans le fichier, avant toute synchronisation) et
  // écraser silencieusement le vrai catalogue enregistré sur le serveur
  // (articles, catégories, etc. semblent alors "disparaître" pour tout le monde).
  var initialStateLoaded = false;
  var prevBatchIds = null;
  var prevTxIds = null;
  window.FSS_IS_SERVER = (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '');
  window.users = window.users || [];
  window.nextUserId = window.nextUserId || 1;
  window.logoData = window.logoData || null;
  window.etabInfo = window.etabInfo || { nom: 'FSS-CAISSE', tel: '', adr: '', rccm: '', nif: '', msgFin: 'Merci pour votre visite !' };
  window.tables = window.tables || [];
  window.servers = window.servers || [];
  window.caisses = window.caisses || [];
  window.categories = window.categories || [];
  window.categoryAlerteActive = window.categoryAlerteActive || {};
  window.fondsOuverture = window.fondsOuverture || {};
  window.printBatches = window.printBatches || [];
  window.clotureHistorique = window.clotureHistorique || [];
  window.employes = window.employes || [];
  window.pointages = window.pointages || [];
  window.paieEntries = window.paieEntries || [];

  var cmdEnVol = {}, retraitsEnVol = {}, txEnVol = {};
  window.fssTxEnVol = txEnVol;
  function fullState() {
    return {
      arts: arts, clis: clis, fours: fours, cmds: cmds, txs: txs, mouv: mouv,
      prls: prls, entrees: entrees, cmdAttente: cmdAttente, nextTk: nextTk, attenteSeq: attenteSeq,
      users: users, nextUserId: nextUserId, usersRev: window.usersRev || 0, logo: logoData, etab: etabInfo, tables: tables, servers: servers, caisses: caisses, categories: categories, fondsOuverture: fondsOuverture, printBatches: printBatches,
      clotureHistorique: clotureHistorique,
      categoryAlerteActive: categoryAlerteActive,
      artsUpdatedAt: window.artsUpdatedAt || 0,
      employes: employes, pointages: pointages, paieEntries: paieEntries
    };
  }

  function applyEtabToInputs() {
    if (g('etabNom')) g('etabNom').value = etabInfo.nom || '';
    if (g('etabTel')) g('etabTel').value = etabInfo.tel || '';
    if (g('etabAdr')) g('etabAdr').value = etabInfo.adr || '';
    if (g('etabRCCM')) g('etabRCCM').value = etabInfo.rccm || '';
    if (g('etabNIF')) g('etabNIF').value = etabInfo.nif || '';
    if (g('etabMsgFin')) g('etabMsgFin').value = etabInfo.msgFin || 'Merci pour votre visite !';
  }

  function applyState(s) {
    if (!s) return;
    // Vue publique (avant connexion sur un appareil distant) : logo et nom seulement, aucune donnée de caisse.
    if (s._public) {
      logoData = s.logo || null;
      etabInfo = s.etab || etabInfo;
      document.dispatchEvent(new Event('fss:ready'));
      return;
    }
    applying = true;
    initialStateLoaded = true;
    arts = s.arts || [];
    clis = s.clis || [];
    fours = s.fours || [];
    cmds = s.cmds || [];
    txs = s.txs || [];
    // Ventes de ce poste pas encore confirmées par le serveur : jamais perdues par une diffusion en retard.
    Object.keys(txEnVol).forEach(function (id) {
      var t = txEnVol[id];
      if (!txs.some(function (x) { return x.id === id || (x.ts === t.ts && x.ttc === t.ttc && x.caissier === t.caissier); })) txs.unshift(t);
    });
    // L'impression automatique d'un "bon de commande" à chaque nouvelle vente a
    // été retirée : c'était la cause exacte du bon de commande qui sortait juste
    // avant le ticket de caisse au moment de payer. Seul le ticket de caisse
    // (imprimerRecu, déclenché manuellement, en 2 exemplaires) s'imprime désormais
    // au moment du paiement.
    prevTxIds = txs.map(function (t) { return t.id; });
    mouv = s.mouv || [];
    prls = s.prls || [];
    entrees = s.entrees || [];
    var idsAvantReception = cmdAttente.map(function (c) { return c.id; });
    cmdAttente = (s.cmdAttente || []).filter(function (c) { return !retraitsEnVol[c.id]; });
    Object.keys(cmdEnVol).forEach(function (id) {
      var i = cmdAttente.findIndex(function (c) { return c.id === id; });
      if (i >= 0) cmdAttente[i] = cmdEnVol[id]; else cmdAttente.push(cmdEnVol[id]);
    });
    var idsApresReception = cmdAttente.map(function (c) { return c.id; });
    if (idsAvantReception.join(',') !== idsApresReception.join(',')) {
      logDistant('applyState met à jour cmdAttente sur ce poste : avant=[' + idsAvantReception.join(',') + '] après=[' + idsApresReception.join(',') + ']');
    }
    printBatches = s.printBatches || [];
    if (prevBatchIds !== null) {
      var nouveauxLots = printBatches.filter(function (bt) { return prevBatchIds.indexOf(bt.batchId) === -1; });
      if (nouveauxLots.length) {
        logDistant('applyState reçoit ' + nouveauxLots.length + ' nouveau(x) lot(s) : ' + nouveauxLots.map(function(b){return b.batchId;}).join(', ') + ' — FSS_IS_SERVER=' + window.FSS_IS_SERVER + ' (hostname=' + location.hostname + ')');
      }
      if (window.FSS_IS_SERVER) {
        nouveauxLots.forEach(function (batch) {
          safe(function () {
            // Même circuit, même écouteur pour tout ce qui doit s'imprimer côté
            // Serveur : bon de commande cuisine ET bilan de clôture — aucune
            // différence de traitement entre les deux, pour garantir que la
            // clôture fonctionne exactement aussi bien depuis un téléphone que
            // les bons de commande, dont on sait qu'ils fonctionnent déjà.
            if (batch.type === 'cloture') {
              logDistant('Tentative impression clôture pour lot ' + batch.batchId);
              if (window.imprimerBilanClotureAuto) { window.fssProfilImprOverride = batch.profil || null; try { window.imprimerBilanClotureAuto(batch.snapshot); } finally { window.fssProfilImprOverride = null; } }
            } else if (batch.type === 'tiroir') {
              if (window.fssOuvrirTiroirLocal) window.fssOuvrirTiroirLocal(batch.pay);
            } else if (batch.type === 'ticket') {
              logDistant('Tentative impression ticket de caisse pour lot ' + batch.batchId + (batch.copies ? (' (' + batch.copies.length + ' exemplaire(s))') : ''));
              if (window.imprimerSilencieux) {
                if (batch.copies && batch.copies.length > 1) {
                  // Même précaution que sur le poste Serveur lui-même : un
                  // travail d'impression séparé par exemplaire.
                  batch.copies.forEach(function (corpsExemplaire, idx) {
                    var htmlExemplaire = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + (batch.css || '') + '</style></head><body>' + corpsExemplaire + '</body></html>';
                    setTimeout(function () { window.imprimerSilencieux(htmlExemplaire, { kind: 'ticket', profil: batch.profil, posteId: batch.posteId }); }, idx * 300);
                  });
                } else {
                  window.imprimerSilencieux(batch.html, { kind: 'ticket', profil: batch.profil, posteId: batch.posteId });
                }
              }
            } else {
              logDistant('Tentative impression bon de commande pour lot ' + batch.batchId + ' (table: ' + batch.tableNom + ', articles: ' + (batch.items||[]).length + ')');
              if (window.imprimerTicketAttente) window.imprimerTicketAttente(batch);
            }
          });
        });
      }
    }
    prevBatchIds = printBatches.map(function (bt) { return bt.batchId; });
    clotureHistorique = s.clotureHistorique || [];
    window.clotureHistorique = clotureHistorique;
    nextTk = s.nextTk || 1;
    attenteSeq = s.attenteSeq || 1;
    users = s.users || [];
    window.usersRev = s.usersRev || 0;
    nextUserId = s.nextUserId || 1;
    logoData = s.logo || null;
    etabInfo = s.etab || { nom: 'FSS-CAISSE', tel: '', adr: '', rccm: '', nif: '', msgFin: 'Merci pour votre visite !' };
    if (s.tables && s.tables.length) tables = s.tables;
    window.tables = tables;
    if (s.servers && s.servers.length) servers = s.servers;
    window.servers = servers;
    if (s.caisses && s.caisses.length) caisses = s.caisses;
    window.caisses = caisses;
    if (Array.isArray(s.categories)) categories = s.categories;
    window.categories = categories;
    categoryAlerteActive = s.categoryAlerteActive || {};
    window.categoryAlerteActive = categoryAlerteActive;
    window.artsUpdatedAt = s.artsUpdatedAt || window.artsUpdatedAt || 0;
    if (s.fondsOuverture) fondsOuverture = s.fondsOuverture;
    window.fondsOuverture = fondsOuverture;
    employes = s.employes || [];
    window.employes = employes;
    pointages = s.pointages || [];
    window.pointages = pointages;
    paieEntries = s.paieEntries || [];
    window.paieEntries = paieEntries;
    refreshAllViews();
    safe(function () { applyEtabToInputs(); });
    applying = false;
    document.dispatchEvent(new Event('fss:ready'));
  }

  function safe(fn) { try { fn(); } catch (e) { /* la vue n'est peut-être pas encore prête */ } }
  // Envoie une ligne de diagnostic au journal texte du serveur (sync-log.txt)
  // — permet de suivre précisément ce qui se passe sur chaque poste sans
  // avoir besoin d'ouvrir la console développeur. Best-effort, ne bloque rien
  // si ça échoue.
  function logDistant(message) {
    try {
      fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message })
      }).catch(function () {});
    } catch (e) {}
  }

  function refreshAllViews() {
    safe(function () { buildCats(); });
    safe(function () { renderProds(''); });
    safe(function () { renderArt(); });
    safe(function () { renderStk(); });
    safe(function () { renderMouv(); });
    safe(function () { renderCli(); });
    safe(function () { renderFour(); });
    safe(function () { renderCmd(); });
    safe(function () { renderTkList(); });
    safe(function () { initTables(); });
    safe(function () { initServers(); });
    safe(function () { initCaisses(); });
    safe(function () { initCategories(); });
    safe(function () { if (window.refreshEtabLogoPreview) refreshEtabLogoPreview(); });
    safe(function () { renderDV(); });
    safe(function () { renderLV(); });
    safe(function () { renderReg(); });
    safe(function () { renderRegG(); });
    safe(function () { renderTopV(); });
    safe(function () { renderTotCat(); });
    safe(function () { renderRap(); });
    safe(function () { initCloture(); });
    safe(function () { renderAttenteBar(); });
    safe(function () { renderPrls(); });
    safe(function () { renderEmp(); });
    safe(function () { renderPtgLive(); });
    safe(function () { renderPaie(); });
    safe(function () { if (g('tkNum')) g('tkNum').textContent = 'TK-#' + ('000' + nextTk).slice(-4); });
  }

  var pushTimer = null;
  function syncPush() {
    if (applying) return; // ne pas renvoyer ce qu'on vient de recevoir
    if (!initialStateLoaded) return; // ne pas écraser le serveur avec des données locales pas encore synchronisées
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      var envoyes = Object.keys(txEnVol);
      fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fullState())
      }).then(function (r) { if (r && r.ok) envoyes.forEach(function (id) { delete txEnVol[id]; }); }).catch(function () {
        safe(function () { toast('⚠️ Synchronisation impossible — vérifiez le serveur', 'e'); });
      });
    }, 150);
  }
  // Variante sans délai (pas de debounce de 150ms), pour les actions rares et
  // critiques comme la clôture de caisse — utile en particulier depuis un
  // téléphone, où un navigateur mis en arrière-plan juste après l'action
  // (verrouillage d'écran, changement d'app) peut suspendre l'exécution du
  // JavaScript avant qu'un envoi différé n'ait eu le temps de se déclencher.
  function syncPushImmediate() {
    if (applying) return;
    if (!initialStateLoaded) return;
    clearTimeout(pushTimer);
    var envoyes = Object.keys(txEnVol);
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fullState())
    }).then(function (r) { if (r && r.ok) envoyes.forEach(function (id) { delete txEnVol[id]; }); return r; }).catch(function () {
      safe(function () { toast('⚠️ Synchronisation impossible — vérifiez le serveur', 'e'); });
    });
  }

  // Envoie l'ajout/mise à jour d'UNE commande en attente précise via la route
  // dédiée du serveur — jamais via l'envoi de l'état complet, qui ne
  // touche plus du tout à cmdAttente côté serveur (voir embedded-server.js).
  // Sans appeler cette route, une commande créée localement semblait
  // fonctionner un instant, puis disparaissait à la synchronisation suivante.
  // Protection anti-disparition : tant qu'une commande envoyée (ou un retrait)
  // n'est pas confirmé par le serveur (+ 4 s de marge pour les diffusions en
  // retard), applyState() la conserve/l'exclut localement. Si le réseau coupe,
  // l'envoi est RÉESSAYÉ automatiquement jusqu'à réussite : la table ne peut
  // plus redevenir « libre » par erreur, quel que soit le nombre de postes.
  window.fssCmdEnVol = cmdEnVol; window.fssRetraitsEnVol = retraitsEnVol;
  function postJsonAvecRetry(url, corps, onOk) {
    var essai = function () {
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) })
        .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); onOk(); })
        .catch(function () { setTimeout(essai, 3000); });
    };
    essai();
  }
  // Après expiration de la protection, on resynchronise avec le serveur : si une
  // commande a été retirée ailleurs entre-temps, elle disparaît ici aussi.
  function resyncCmdAttente() {
    fetch(API).then(function (r) { return r.json(); }).then(function (s) {
      if (s && Array.isArray(s.cmdAttente)) {
        var avant = cmdAttente.map(function (c) { return c.id; }).sort().join(',');
        var apres = s.cmdAttente.filter(function (c) { return !retraitsEnVol[c.id] && !cmdEnVol[c.id]; }).map(function (c) { return c.id; });
        Object.keys(cmdEnVol).forEach(function (id) { apres.push(id); });
        if (avant !== apres.sort().join(',')) applyState(s);
      }
    }).catch(function () {});
  }
  function envoyerCmdAttente(commande) {
    delete retraitsEnVol[commande.id];
    cmdEnVol[commande.id] = commande;
    return new Promise(function (resolve) {
      postJsonAvecRetry('/api/cmdattente/ajouter', commande, function () {
        setTimeout(function () { if (cmdEnVol[commande.id] === commande) delete cmdEnVol[commande.id]; resyncCmdAttente(); }, 4000);
        resolve();
      });
    });
  }
  // Identifiant stable de CE poste (généré une fois, conservé) + nom de l'ordinateur.
  // Sert à savoir quel poste a émis un bon de commande, pour l'envoyer sur les
  // imprimantes que le Serveur a affectées à ce poste.
  var posteId = null;
  try {
    posteId = localStorage.getItem('fss-poste-id');
    if (!posteId) {
      posteId = 'PC-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      localStorage.setItem('fss-poste-id', posteId);
    }
  } catch (e) { posteId = posteId || ('PC-' + Math.random().toString(36).slice(2, 8)); }
  window.FSS_POSTE_ID = posteId;
  // Sur un téléphone/navigateur (pas d'application Windows), le nom de l'hôte serait l'adresse du
  // Serveur, identique pour tous : on fabrique un nom lisible (type + modèle + 4 derniers caractères).
  function nomPosteAuto() {
    var ua = navigator.userAgent || '';
    var type = /Android/i.test(ua) ? 'Téléphone Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iPhone/iPad' : 'Navigateur';
    var m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/);
    var modele = m && m[1] && !/^(K|wv)$/.test(m[1].trim()) ? ' ' + m[1].trim() : '';
    return type + modele + ' #' + String(posteId).slice(-4);
  }
  window.FSS_POSTE_NOM = (window.electronAPI && window.electronAPI.getHostname) ? (location.hostname || 'Poste') : nomPosteAuto();
  function signalerPoste() {
    var nom = window.FSS_POSTE_NOM;
    var envoi = function (n) {
      fetch('/api/postes/hello', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: posteId, nom: n, serveur: !!window.FSS_IS_SERVER })
      }).catch(function () {});
    };
    if (window.electronAPI && window.electronAPI.getHostname) {
      window.electronAPI.getHostname().then(function (h) { window.FSS_POSTE_NOM = h || nom; envoi(h || nom); }).catch(function () { envoi(nom); });
    } else { envoi(nom); }
  }
  signalerPoste();
  setInterval(signalerPoste, 60000);

  function envoyerBonCommande(batch) {
    batch.posteId = batch.posteId || posteId;
    batch.posteNom = batch.posteNom || window.FSS_POSTE_NOM;
    if (!batch.profil && window.fssProfilImpression) batch.profil = window.fssProfilImpression();
    return fetch('/api/printbatches/ajouter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch)
    }).catch(function () {
      safe(function () { toast('⚠️ Impossible d\'envoyer le bon de commande au serveur — vérifiez la connexion', 'e'); });
    });
  }
  function envoyerClotureArchive(entree) {
    return fetch('/api/cloture/archiver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entree)
    }).catch(function () {
      safe(function () { toast('⚠️ Impossible d\'archiver la clôture sur le serveur — vérifiez la connexion', 'e'); });
    });
  }
  function retirerCmdAttente(id) {
    delete cmdEnVol[id];
    retraitsEnVol[id] = true;
    return new Promise(function (resolve) {
      postJsonAvecRetry('/api/cmdattente/retirer', { id: id }, function () {
        setTimeout(function () { delete retraitsEnVol[id]; resyncCmdAttente(); }, 4000);
        resolve();
      });
    });
  }
  function enregistrerTable(table) {
    return fetch('/api/tables/enregistrer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(table)
    }).catch(function () {
      safe(function () { toast('⚠️ Impossible d\'enregistrer la table sur le serveur — vérifiez la connexion', 'e'); });
    });
  }
  function supprimerTable(n) {
    return fetch('/api/tables/supprimer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ n: n })
    }).catch(function () {
      safe(function () { toast('⚠️ Impossible de synchroniser la suppression de la table — vérifiez la connexion', 'e'); });
    });
  }

  window.fssSyncPush = syncPush;
  window.fssSyncPushImmediate = syncPushImmediate;
  window.fssEnvoyerCmdAttente = envoyerCmdAttente;
  window.fssEnvoyerBonCommande = envoyerBonCommande;
  window.fssRetirerCmdAttente = retirerCmdAttente;
  window.fssEnvoyerClotureArchive = envoyerClotureArchive;
  window.fssEnregistrerTable = enregistrerTable;
  window.fssSupprimerTable = supprimerTable;
  // Si l'app se ferme (fermeture manuelle, redémarrage...), on force
  // immédiatement l'envoi de tout changement en attente, et on prévient le
  // processus principal une fois que c'est VRAIMENT terminé (pas juste lancé)
  // — pour qu'il attende la vraie fin avant de fermer la fenêtre.
  if (window.electronAPI && window.electronAPI.onFlushAvantFermeture) {
    window.electronAPI.onFlushAvantFermeture(function () {
      var confirmer = function () {
        if (window.electronAPI.confirmerFlushTermine) window.electronAPI.confirmerFlushTermine();
      };
      // Même protection que pour la déconnexion : une commande en cours de
      // reprise/édition (donc temporairement retirée du serveur) doit être
      // remise en attente avant toute fermeture ou tout rechargement — via sa
      // route dédiée et protégée, en attendant qu'elle soit vraiment partie.
      //
      // Important : on ne renvoie PLUS l'état complet ici (contrairement à
      // avant) — ce poste pourrait avoir une vue en retard des données (ex:
      // resté un moment en arrière-plan), et renvoyer son état complet
      // risquait d'écraser des changements plus récents faits ailleurs.
      if (window.resumingAttenteId && window.tkt && window.tkt.length && typeof window.clearTk === 'function') {
        safe(function () { window.clearTk(); });
        if (window.fssDerniereEnvoyerCmdAttentePromise && typeof window.fssDerniereEnvoyerCmdAttentePromise.then === 'function') {
          window.fssDerniereEnvoyerCmdAttentePromise.then(confirmer).catch(confirmer);
          return;
        }
      }
      confirmer();
    });
  }
  // Nouvelle tentative automatique tant qu'une vente n'est pas confirmée par le serveur.
  setInterval(function () { if (Object.keys(txEnVol).length) syncPush(); }, 5000);
  // Après connexion (appareil distant) : le jeton est actif, on recharge les vraies données et on reconnecte le temps réel.
  window.fssApresConnexion = function () {
    try { if (socket) { socket.disconnect(); socket.connect(); } } catch (e) {}
    return fetch(API).then(function (r) { return r.json(); }).then(applyState);
  };
  window.fssFullState = fullState;
  window.fssApplyState = applyState;

  // Fonctions qui modifient le catalogue d'articles — leur exécution met à
  // jour un horodatage dédié, pour que le serveur puisse toujours reconnaître
  // et garder la VRAIE dernière mise à jour, même si un autre poste, avec une
  // version plus ancienne du catalogue, envoie un changement juste après.
  function envoyerChangementsArticles(avant) {
    try {
      var liste = window.arts || arts || [], apres = {}, upserts = [], supprimes = [];
      liste.forEach(function (x) {
        apres[x.id] = true;
        if (avant[x.id] !== JSON.stringify(x)) upserts.push(x);
      });
      Object.keys(avant).forEach(function (id) {
        if (!apres[id]) { var n = Number(id); supprimes.push(String(n) === id ? n : id); }
      });
      if (upserts.length || supprimes.length) postJsonAvecRetry('/api/arts/maj', { upserts: upserts, supprimes: supprimes }, function () {});
    } catch (e) {}
  }
  window.fssArtsSupprimer = function (ids) { try { postJsonAvecRetry('/api/arts/maj', { upserts: [], supprimes: ids }, function () {}); } catch (e) {} };
  var FONCTIONS_ARTICLES = ['saveArt', 'delArt', 'togArt', 'importArticles', 'viderArticles', 'saveStk', 'toggleAlerteCategorie'];
  function wrap(name) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () {
      var estArticle = FONCTIONS_ARTICLES.indexOf(name) !== -1;
      var ticketAvant = (name === 'valPay' && window.txs && window.txs[0]) || null;
      var avant = null;
      if (estArticle) { avant = {}; (window.arts || arts || []).forEach(function (x) { avant[x.id] = JSON.stringify(x); }); }
      var r = orig.apply(this, arguments);
      if (name === 'valPay') {
        var nouveau = window.txs && window.txs[0];
        if (nouveau && nouveau !== ticketAvant && nouveau.id) txEnVol[nouveau.id] = nouveau;
      }
      if (estArticle) {
        window.artsUpdatedAt = Date.now();
        // Envoi IMMÉDIAT au serveur des seuls articles ajoutés / modifiés / supprimés (fusion côté
        // serveur) — un seul article suffit, sans dépendre de la synchronisation complète.
        envoyerChangementsArticles(avant);
      }
      syncPush();
      return r;
    };
  }

  [
    'saveArt', 'delArt', 'togArt', 'saveStk',
    'saveCli', 'delCli', 'saveFour', 'delFour',
    'saveCmd', 'delCmd', 'valPay', 'addPrel', 'razCaisse',
    'mettreEnAttente', 'reprendreAttente', 'supprimerAttente',
    'saveEmp', 'delEmp', 'clockIn', 'clockOut', 'savePointageManuel', 'delPointage', 'savePaieDetail',
    'importArticles', 'viderArticles', 'toggleAlerteCategorie'
  ].forEach(wrap);

  if (socket) {
    socket.on('state:changed', function (s) { applyState(s); });
    // Erreur d'impression renvoyée par le Serveur (imprimante éteinte, injoignable...) :
    // affichée uniquement sur le poste qui avait envoyé le bon.
    socket.on('print:error', function (e) {
      if (!e || (e.posteId && e.posteId !== posteId)) return;
      safe(function () { toast('❌ ' + (e.message || 'Erreur d\'impression'), 'e'); });
    });
    socket.on('connect', function () {
      safe(function () { toast('Connecté au serveur FSS-CAISSE', 's'); });
    });
    socket.on('disconnect', function () {
      safe(function () { toast('⚠️ Connexion au serveur perdue', 'e'); });
    });
  }

  window.addEventListener('load', function () {
    fetch(API).then(function (r) { return r.json(); }).then(applyState).catch(function () {
      safe(function () { toast('⚠️ Serveur injoignable — mode hors-ligne', 'e'); });
    });
  });
})();
