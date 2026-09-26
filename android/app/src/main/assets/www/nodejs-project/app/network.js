// FSS-CAISSE — Synchronisation réseau (multi-postes)
// Ce script connecte l'application au serveur central FSS-CAISSE
// et synchronise en temps réel les données entre tous les postes.
(function () {
  var socket = (typeof io === 'function') ? io() : null;
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
  var prevTxIds = null;
  // --- Suivi PERSISTANT des bons de commande déjà imprimés -----------------------------------
  // Avant : ce suivi (prevBatchIds) n'existait qu'en mémoire (variable JS). Sur du matériel
  // Android bas de gamme (type TPE H10S), le système tue très souvent l'activité/la WebView en
  // arrière-plan pour économiser la batterie (gestion "auto-démarrage"/"appli protégée" très
  // agressive sur ces ROM constructeur), même quand un service de premier plan tourne encore.
  // À chaque redémarrage de l'activité, prevBatchIds repartait de zéro (null), et la toute
  // première synchronisation qui suit marque alors TOUS les bons de commande déjà en attente
  // (y compris ceux jamais imprimés à cause du redémarrage) comme "déjà connus" — ils ne sont
  // alors plus JAMAIS imprimés, silencieusement, sans la moindre erreur visible. C'est ce qui
  // explique un bon de commande qui ne sort "jamais" du TPE alors que l'addition/le reçu
  // (imprimés manuellement, appli forcément au premier plan à ce moment) fonctionnent bien.
  // Fix : mémoriser les identifiants des lots déjà imprimés dans localStorage, qui survit aux
  // redémarrages de l'activité/du processus. Un lot n'est marqué "imprimé" qu'après la tentative
  // d'impression elle-même, jamais juste parce qu'il a été "vu" une fois.
  var PRINTED_BATCH_IDS_KEY = 'fss_printed_batch_ids_v1';
  var printedBatchIds = null; // null = pas encore chargé depuis localStorage
  function chargerLotsImprimes() {
    if (printedBatchIds !== null) return printedBatchIds;
    try {
      var raw = localStorage.getItem(PRINTED_BATCH_IDS_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      printedBatchIds = (parsed && parsed instanceof Array) ? parsed : null;
    } catch (e) {
      printedBatchIds = null;
    }
    return printedBatchIds;
  }
  function sauverLotsImprimes(arr) {
    // On garde seulement les 500 derniers identifiants pour éviter une croissance illimitée du
    // stockage local au fil des mois (printBatches lui-même n'est jamais purgé côté serveur).
    var trimmed = arr.length > 500 ? arr.slice(arr.length - 500) : arr;
    printedBatchIds = trimmed;
    try {
      localStorage.setItem(PRINTED_BATCH_IDS_KEY, JSON.stringify(trimmed));
    } catch (e) {
      // Stockage plein/indisponible : on continue en mémoire pour cette session, tant pis pour
      // la persistance — ce n'est pas pire que l'ancien comportement 100% en mémoire.
    }
  }
  window.FSS_IS_SERVER = (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '');
  // Identifiant unique de ce poste pour la durée de la session (re-généré à chaque
  // rechargement) — permet à un poste client de reconnaître "ses propres" bons de
  // commande dans le flux synchronisé, pour imprimer sa copie localement sans imprimer
  // aussi celles des autres postes.
  window.FSS_POSTE_ID = 'poste-' + Math.random().toString(36).slice(2) + '-' + Date.now();
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

  function fullState() {
    return {
      arts: arts, clis: clis, fours: fours, cmds: cmds, txs: txs, mouv: mouv,
      prls: prls, cmdAttente: cmdAttente, nextTk: nextTk, attenteSeq: attenteSeq,
      users: users, nextUserId: nextUserId, logo: logoData, etab: etabInfo, tables: tables, servers: servers, caisses: caisses, categories: categories, fondsOuverture: fondsOuverture, printBatches: printBatches,
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
    applying = true;
    initialStateLoaded = true;
    arts = s.arts || [];
    clis = s.clis || [];
    fours = s.fours || [];
    cmds = s.cmds || [];
    txs = s.txs || [];
    // L'impression automatique d'un "bon de commande" à chaque nouvelle vente a
    // été retirée : c'était la cause exacte du bon de commande qui sortait juste
    // avant le ticket de caisse au moment de payer. Seul le ticket de caisse
    // (imprimerRecu, déclenché manuellement, en 2 exemplaires) s'imprime désormais
    // au moment du paiement.
    prevTxIds = txs.map(function (t) { return t.id; });
    mouv = s.mouv || [];
    prls = s.prls || [];
    cmdAttente = s.cmdAttente || [];
    printBatches = s.printBatches || [];
    var lotsConnus = chargerLotsImprimes();
    if (lotsConnus === null) {
      // Première synchronisation jamais vue sur cet appareil (installation neuve, ou stockage
      // local effacé) : comme avant, on ne réimprime pas l'historique déjà présent au moment
      // de ce tout premier chargement — on le marque directement comme "déjà traité".
      sauverLotsImprimes(printBatches.map(function (bt) { return bt.batchId; }));
    } else {
      // Même circuit, même écouteur pour tout ce qui doit s'imprimer côté Serveur : bon de
      // commande cuisine ET bilan de clôture — aucune différence de traitement entre les deux.
      // Poste client (TPE ou PC) : n'imprime QUE ses propres bons de commande (jamais ceux des
      // autres postes, jamais les bilans de clôture — réservés au serveur).
      var nouveauxLots = printBatches.filter(function (bt) {
        if (lotsConnus.indexOf(bt.batchId) !== -1) return false;
        if (window.FSS_IS_SERVER) return true;
        return bt.type !== 'cloture' && bt.posteId === window.FSS_POSTE_ID;
      });
      if (nouveauxLots.length) {
        nouveauxLots.forEach(function (batch) {
          safe(function () {
            if (batch.type === 'cloture') {
              if (window.imprimerBilanClotureAuto) window.imprimerBilanClotureAuto(batch.snapshot);
            } else {
              if (window.imprimerTicketAttente) window.imprimerTicketAttente(batch);
            }
          });
        });
        sauverLotsImprimes(lotsConnus.concat(nouveauxLots.map(function (bt) { return bt.batchId; })));
      }
    }
    clotureHistorique = s.clotureHistorique || [];
    window.clotureHistorique = clotureHistorique;
    nextTk = s.nextTk || 1;
    attenteSeq = s.attenteSeq || 1;
    users = s.users || [];
    nextUserId = s.nextUserId || 1;
    logoData = s.logo || null;
    etabInfo = s.etab || { nom: 'FSS-CAISSE', tel: '', adr: '', rccm: '', nif: '', msgFin: 'Merci pour votre visite !' };
    if (s.tables && s.tables.length) tables = s.tables;
    window.tables = tables;
    if (s.servers && s.servers.length) servers = s.servers;
    window.servers = servers;
    if (s.caisses && s.caisses.length) caisses = s.caisses;
    window.caisses = caisses;
    if (s.categories && s.categories.length) categories = s.categories;
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

  function safe(fn) {
    try {
      fn();
    } catch (e) {
      // Avant : erreur totalement avalée, sans aucune trace — un bon de commande qui échoue
      // pour une raison inattendue (autre que le fix ci-dessus) restait invisible pour
      // toujours. On journalise maintenant dans la console (visible via un débogage distant)
      // ET on tente un toast, qui reste utile si l'appli est au premier plan au moment de
      // l'erreur (par ex. en cas de nouvelle anomalie non encore identifiée).
      try { console.error('[fss-print]', e && e.message ? e.message : e); } catch (e2) {}
      try { if (window.toast) toast('⚠️ Erreur impression auto : ' + (e && e.message ? e.message : e), 'e'); } catch (e2) {}
    }
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
      fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fullState())
      }).catch(function () {
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
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fullState())
    }).catch(function () {
      safe(function () { toast('⚠️ Synchronisation impossible — vérifiez le serveur', 'e'); });
    });
  }

  // Envoie l'ajout/mise à jour d'UNE commande en attente précise via la route
  // dédiée du serveur — jamais via l'envoi de l'état complet, qui ne
  // touche plus du tout à cmdAttente côté serveur (voir embedded-server.js).
  // Sans appeler cette route, une commande créée localement semblait
  // fonctionner un instant, puis disparaissait à la synchronisation suivante.
  function envoyerCmdAttente(commande) {
    return fetch('/api/cmdattente/ajouter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commande)
    }).catch(function () {
      safe(function () { toast('⚠️ Impossible d\'envoyer la commande au serveur — vérifiez la connexion', 'e'); });
    });
  }
  function retirerCmdAttente(id) {
    return fetch('/api/cmdattente/retirer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id })
    }).catch(function () {
      safe(function () { toast('⚠️ Impossible de synchroniser la suppression — vérifiez la connexion', 'e'); });
    });
  }

  window.fssSyncPush = syncPush;
  window.fssSyncPushImmediate = syncPushImmediate;
  window.fssEnvoyerCmdAttente = envoyerCmdAttente;
  window.fssRetirerCmdAttente = retirerCmdAttente;
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
  window.fssFullState = fullState;
  window.fssApplyState = applyState;

  // Fonctions qui modifient le catalogue d'articles — leur exécution met à
  // jour un horodatage dédié, pour que le serveur puisse toujours reconnaître
  // et garder la VRAIE dernière mise à jour, même si un autre poste, avec une
  // version plus ancienne du catalogue, envoie un changement juste après.
  var FONCTIONS_ARTICLES = ['saveArt', 'delArt', 'togArt', 'importArticles', 'viderArticles'];
  function wrap(name) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () {
      var r = orig.apply(this, arguments);
      if (FONCTIONS_ARTICLES.indexOf(name) !== -1) window.artsUpdatedAt = Date.now();
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
    'importArticles', 'viderArticles'
  ].forEach(wrap);

  if (socket) {
    socket.on('state:changed', function (s) { applyState(s); });
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
