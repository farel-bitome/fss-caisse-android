const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { Server } = require('socket.io');

// Filet de sécurité global : une erreur imprévue n'importe où (surtout
// probable quand plusieurs postes sont connectés en même temps et envoient
// des changements proches dans le temps) ne doit JAMAIS faire planter le
// serveur entier — ce qui coupait TOUS les postes connectés d'un coup. On
// journalise l'erreur au lieu de laisser le processus s'arrêter.
process.on('uncaughtException', (err) => {
  console.error('[FSS-CAISSE] Erreur serveur non gérée (ignorée, le serveur continue) :', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[FSS-CAISSE] Promesse rejetée non gérée (ignorée, le serveur continue) :', err);
});

module.exports = function startEmbeddedServer(port, userDataDir, appRootDir) {
  return new Promise((resolve, reject) => {
    const appStaticDir = path.join(appRootDir, 'app');
    const dataFile = path.join(userDataDir, 'data.json');
    const backupDataFile = path.join(userDataDir, 'data.backup.json');
    const logFile = path.join(userDataDir, 'sync-log.txt');
    function ecrireJournal(ligne) {
      try {
        var horodatage = new Date().toLocaleString('fr-FR');
        fs.appendFileSync(logFile, '[' + horodatage + '] ' + ligne + '\n');
      } catch (e) {}
    }
    const defaultFile = path.join(appRootDir, 'server-data', 'data.default.json');
    const airtelConfigFile = path.join(userDataDir, 'airtel-config.json');
    const pvitConfigFile = path.join(userDataDir, 'pvit-config.json');

    function loadState() {
      // RÈGLE : la base de données posée dans le dossier de l'application (data.json) est
      // TOUJOURS celle qui est utilisée. Jamais de copie de secours, jamais de données par
      // défaut, jamais de remplacement automatique quand data.json existe.
      // - data.json absent  -> première installation : base vierge (données par défaut)
      // - data.json présent -> il est lu tel quel ; s'il est illisible on S'ARRÊTE avec un message,
      //   sans rien écrire ni remplacer (le fichier reste intact pour être réparé/remplacé).
      let state;
      if (fs.existsSync(dataFile)) {
        let brut;
        try {
          brut = fs.readFileSync(dataFile, 'utf8');
          if (brut.charCodeAt(0) === 0xFEFF) brut = brut.slice(1);
          state = JSON.parse(brut);
        } catch (e) {
          throw new Error('Le fichier de base de données (' + dataFile + ') est illisible : ' + e.message +
            '. Il n\'a PAS été modifié ni remplacé. Remplacez-le par un fichier valide puis relancez le logiciel.');
        }
        if (!state || typeof state !== 'object' || Array.isArray(state)) {
          throw new Error('Le fichier de base de données (' + dataFile + ') ne contient pas une base valide. ' +
            'Il n\'a PAS été modifié ni remplacé. Remplacez-le par un fichier valide puis relancez le logiciel.');
        }
        return state;
      }
      console.error('Aucun fichier de données : première installation, base vierge.');
      return JSON.parse(fs.readFileSync(defaultFile, 'utf8'));
    }

    // ---- Sauvegarde des données ----
    // AVANT : à chaque modification (de n'importe quel poste), le serveur écrivait tout le fichier de
    // façon SYNCHRONE (JSON indenté + copie de secours + écriture) dans le processus principal de
    // l'application : avec un gros catalogue ou plusieurs postes, la fenêtre se figeait quelques
    // secondes, puis de plus en plus souvent -> « le logiciel plante après un temps ».
    // MAINTENANT : les écritures sont regroupées (délai de 400 ms), JSON compact, fichiers écrits en
    // asynchrone (le processus principal reste réactif), et tout ce qui est en attente est écrit
    // de façon synchrone à la fermeture : aucune perte de données.
    let saveTimer = null;
    let saveEnAttente = null;
    let saveChaine = Promise.resolve();
    const fsp = fs.promises;
    function ecrireEtat(state) {
      const json = JSON.stringify(state);
      const tmpFile = dataFile + '.tmp';
      // Copie de secours du dernier état VALIDE, puis écriture atomique (fichier temporaire + rename :
      // un plantage en plein milieu ne peut jamais laisser un fichier de données à moitié écrit).
      return fsp.copyFile(dataFile, backupDataFile).catch(() => {})
        .then(() => fsp.writeFile(tmpFile, json))
        .then(() => fsp.rename(tmpFile, dataFile))
        .catch((e) => console.error('Écriture des données impossible :', e && e.message));
    }
    function saveState(state) {
      saveEnAttente = state;
      if (saveTimer) return;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        const s = saveEnAttente;
        saveEnAttente = null;
        if (s) saveChaine = saveChaine.then(() => ecrireEtat(s));
      }, 400);
    }
    // Écriture synchrone de ce qui est encore en attente (fermeture de l'application).
    function saveStateImmediat() {
      if (!saveEnAttente) return;
      const s = saveEnAttente;
      saveEnAttente = null;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      try {
        const tmpFile = dataFile + '.tmp';
        try { if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, backupDataFile); } catch (e) {}
        fs.writeFileSync(tmpFile, JSON.stringify(s));
        fs.renameSync(tmpFile, dataFile);
      } catch (e) { console.error('Écriture finale impossible :', e && e.message); }
    }
    process.on('exit', saveStateImmediat);

    // ---- Config Airtel Money : stockée à part, JAMAIS envoyée au navigateur/synchronisée ----
    function loadAirtelConfig() {
      try {
        if (fs.existsSync(airtelConfigFile)) {
          return JSON.parse(fs.readFileSync(airtelConfigFile, 'utf8'));
        }
      } catch (e) { /* ignore */ }
      return { clientId: '', clientSecret: '', pin: '', country: 'GA', currency: 'XAF', environment: 'staging' };
    }
    function saveAirtelConfig(cfg) {
      fs.writeFileSync(airtelConfigFile, JSON.stringify(cfg, null, 2));
    }

    async function airtelGetToken(cfg) {
      const base = cfg.environment === 'production' ? 'https://openapi.airtel.africa' : 'https://openapiuat.airtel.africa';
      const res = await fetch(base + '/auth/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          grant_type: 'client_credentials'
        })
      });
      if (!res.ok) throw new Error('Échec authentification Airtel (' + res.status + ')');
      const data = await res.json();
      return data.access_token;
    }

    let state = loadState();

    const expressApp = express();
    const server = http.createServer(expressApp);
    const io = new Server(server);
    // Diffusion de l'état regroupée : plusieurs changements rapprochés = UN seul envoi (au lieu d'un envoi complet
    // par changement). Évite de saturer le processus principal (et donc de figer la fenêtre) quand l'historique grossit.
    let diffusionTimer = null;
    function diffuserEtat() {
      if (diffusionTimer) return;
      diffusionTimer = setTimeout(() => { diffusionTimer = null; try { io.emit('state:changed', state); } catch (e) {} }, 150);
    }

    expressApp.use(function (req, res, next) {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,POST');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });
    expressApp.use(express.json({ limit: '10mb' }));
    // Vérification d'un compte admin / super-admin pour l'accès technicien des postes clients (rien n'est mémorisé côté client).
    const essaisVerif = {};
    expressApp.post('/api/verif-admin', (req, res) => {
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || '?';
      const e = essaisVerif[ip] || { n: 0, bloque: 0 };
      if (Date.now() < e.bloque) return res.status(429).json({ ok: false });
      const nom = String((req.body && req.body.nom) || '').trim().toLowerCase();
      const mdp = String((req.body && req.body.mdp) || '');
      const ok = mdp !== '' && (state.users || []).some(u => u && (u.super || u.full) && u.mdp === mdp && (!nom || String(u.nom).toLowerCase() === nom));
      if (ok) { delete essaisVerif[ip]; return res.json({ ok: true }); }
      e.n++; if (e.n >= 5) { e.n = 0; e.bloque = Date.now() + 30000; }
      essaisVerif[ip] = e;
      res.json({ ok: false });
    });
    // Compression gzip des réponses (surtout utile pour /api/state, qui peut
    // devenir volumineux avec beaucoup d'articles/tables/historique) — réduit
    // nettement le temps de chargement sur un réseau mobile plus faible.
    // Implémenté avec le module natif "zlib" de Node, sans dépendance externe
    // à installer.
    expressApp.use(function (req, res, next) {
      var acceptEncoding = req.headers['accept-encoding'] || '';
      if (acceptEncoding.indexOf('gzip') === -1) return next();
      var originalJson = res.json.bind(res);
      var originalSend = res.send.bind(res);
      function compresserEtEnvoyer(corps) {
        var buffer = Buffer.isBuffer(corps) ? corps : Buffer.from(typeof corps === 'string' ? corps : JSON.stringify(corps));
        zlib.gzip(buffer, function (err, resultat) {
          if (err) { res.set('Content-Type', 'application/json'); return originalSend(buffer); }
          res.set('Content-Encoding', 'gzip');
          res.set('Content-Type', 'application/json');
          originalSend(resultat);
        });
      }
      res.json = function (corps) { compresserEtEnvoyer(corps); return res; };
      next();
    });
    expressApp.use(express.static(appStaticDir));

    expressApp.get('/api/state', (req, res) => {
      res.json(state);
    });

    // ---- Commandes en attente : gérées EXCLUSIVEMENT via des actions ciblées ----
    // Fini le système de fusion par délai de grâce (imprécis, pouvait quand
    // même perdre une commande si un poste restait en retard plus de 15s —
    // fréquent sur un wifi de restaurant chargé). Désormais, cmdAttente n'est
    // JAMAIS remplacé en bloc par le "fullState" envoyé par un poste — cette
    // route ignore volontairement tout cmdAttente reçu ici. Les seules façons
    // de le modifier sont les 3 routes ciblées ci-dessous (ajouter, retirer,
    // remplacer UNE commande précise par son id) — aucun risque qu'un poste
    // avec une vue partielle/en retard n'écrase les commandes des autres.
    expressApp.post('/api/cmdattente/ajouter', (req, res) => {
      try {
        state.cmdAttente = state.cmdAttente || [];
        state.cmdAttente = state.cmdAttente.filter(function (c) { return c.id !== req.body.id; });
        state.cmdAttente.push(req.body);
        saveState(state);
        diffuserEtat();
        ecrireJournal('Commande en attente ajoutée : ' + req.body.id + ' (' + req.body.tableNom + ', ' + req.body.total + ' FCFA) — liste complète après ajout (' + state.cmdAttente.length + ') : ' + state.cmdAttente.map(function (c) { return c.id; }).join(', '));
        res.json({ ok: true });
      } catch (e) {
        console.error('[FSS-CAISSE] Erreur ajout commande en attente :', e);
        res.status(500).json({ ok: false, error: e.message });
      }
    });
    expressApp.post('/api/cmdattente/retirer', (req, res) => {
      try {
        state.cmdAttente = (state.cmdAttente || []).filter(function (c) { return c.id !== req.body.id; });
        saveState(state);
        diffuserEtat();
        ecrireJournal('Commande en attente retirée : ' + req.body.id + ' — liste complète après retrait (' + state.cmdAttente.length + ') : ' + state.cmdAttente.map(function (c) { return c.id; }).join(', '));
        res.json({ ok: true });
      } catch (e) {
        console.error('[FSS-CAISSE] Erreur suppression commande en attente :', e);
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // Petite route de diagnostic : permet à l'application (n'importe quel
    // poste) d'écrire une ligne dans le journal texte du serveur — utile pour
    // suivre précisément ce qui se passe côté écran sans avoir besoin
    // d'ouvrir la console développeur.
    expressApp.post('/api/log', (req, res) => {
      try {
        ecrireJournal('[poste] ' + (req.body && req.body.message ? req.body.message : ''));
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ ok: false });
      }
    });

    // Comme pour les commandes en attente : une table (création, modification
    // du statut Libre/Occupée/Réservée, suppression) passe désormais par sa
    // propre route dédiée, plutôt que par l'envoi de l'état complet. Fini la
    // comparaison d'horodatages entre appareils (tsModif), qui restait
    // fragile dès qu'une horloge était mal réglée quelque part — cause du
    // souci "le logiciel écrase toujours les tables". Le serveur applique
    // directement le changement demandé, sans jamais avoir besoin de deviner
    // laquelle de deux versions est "la plus récente".
    expressApp.post('/api/tables/enregistrer', (req, res) => {
      try {
        state.tables = state.tables || [];
        var idx = state.tables.findIndex(function (t) { return t.n === req.body.n; });
        if (idx >= 0) state.tables[idx] = req.body; else state.tables.push(req.body);
        saveState(state);
        diffuserEtat();
        ecrireJournal('Table enregistrée : n°' + req.body.n + ' (' + req.body.nom + ', statut: ' + req.body.st + ')');
        res.json({ ok: true });
      } catch (e) {
        console.error('[FSS-CAISSE] Erreur enregistrement table :', e);
        res.status(500).json({ ok: false, error: e.message });
      }
    });
    expressApp.post('/api/tables/supprimer', (req, res) => {
      try {
        state.tables = (state.tables || []).filter(function (t) { return t.n !== req.body.n; });
        saveState(state);
        diffuserEtat();
        ecrireJournal('Table supprimée : n°' + req.body.n);
        res.json({ ok: true });
      } catch (e) {
        console.error('[FSS-CAISSE] Erreur suppression table :', e);
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // Même principe, appliqué cette fois aux bons de commande cuisine et aux
    // bilans de clôture (printBatches) : route dédiée et immédiate, plutôt
    // que de compter sur la synchronisation générale (débouncée, et qui
    // pouvait être affectée par des versions concurrentes). Le serveur ajoute
    // directement le bon et diffuse le changement sans délai — c'est la même
    // approche que celle qui fonctionne déjà de façon fiable pour les
    // commandes en attente et les tables.
    expressApp.post('/api/printbatches/ajouter', (req, res) => {
      try {
        state.printBatches = state.printBatches || [];
        state.printBatches = state.printBatches.filter(function (bt) { return bt.batchId !== req.body.batchId; });
        state.printBatches.push(req.body);
        // Purge les bons de plus de 2h connus du serveur, pour ne pas
        // accumuler indéfiniment — basé uniquement sur l'horloge du serveur.
        var MAINTENANT = Date.now();
        state.printBatches.forEach(function (bt) { if (!bt._recuLe) bt._recuLe = MAINTENANT; });
        state.printBatches = state.printBatches.filter(function (bt) { return (MAINTENANT - bt._recuLe) < 2 * 60 * 60 * 1000; });
        saveState(state);
        diffuserEtat();
        ecrireJournal('[route dédiée] Bon de commande ajouté : ' + req.body.batchId + ' (table: ' + req.body.tableNom + ', ' + (req.body.items || []).length + ' article(s)) — total en file : ' + state.printBatches.length);
        res.json({ ok: true });
      } catch (e) {
        console.error('[FSS-CAISSE] Erreur ajout bon de commande :', e);
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // ---- Postes connectés (pour affecter les imprimantes à chaque poste) ----
    // Chaque poste (serveur ou client) se signale périodiquement avec un
    // identifiant stable et son nom d'ordinateur. Le poste Serveur s'en sert,
    // dans Paramètres → Périphériques, pour choisir sur quelle(s) imprimante(s)
    // chaque poste imprime ses bons de commande.
    const postesFile = path.join(userDataDir, 'postes.json');
    let postes = {};
    try { postes = JSON.parse(fs.readFileSync(postesFile, 'utf8')) || {}; } catch (e) { postes = {}; }
    expressApp.post('/api/postes/hello', (req, res) => {
      try {
        const b = req.body || {};
        if (!b.id) return res.status(400).json({ ok: false });
        const ancien = postes[b.id] || {};
        postes[b.id] = {
          id: String(b.id),
          nom: String(b.nom || ancien.nom || b.id).slice(0, 60),
          serveur: !!b.serveur,
          vu: Date.now()
        };
        // enregistrement disque limité (au plus toutes les 30 s) : inutile à chaque signal
        const maintenant = Date.now();
        if (!postes._ecrit || maintenant - postes._ecrit > 30000 || !ancien.id) {
          postes._ecrit = maintenant;
          try { fs.writeFileSync(postesFile, JSON.stringify(postes)); } catch (e) {}
        }
        res.json({ ok: true });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });
    expressApp.get('/api/postes', (req, res) => {
      res.json(Object.keys(postes).filter(function (k) { return k !== '_ecrit'; }).map(function (k) { return postes[k]; }));
    });
    // Erreur d'impression (imprimante éteinte, injoignable...) : diffusée à tous
    // les postes ; seul le poste émetteur du bon l'affiche.
    expressApp.post('/api/printerrors', (req, res) => {
      try {
        io.emit('print:error', req.body || {});
        ecrireJournal('Erreur impression : ' + JSON.stringify(req.body || {}).slice(0, 300));
        res.json({ ok: true });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // ---- Archives de clôture : route dédiée (même principe que cmdAttente) ----
    // Insère ou met à jour UNE entrée d'historique par son id, sans dépendre de
    // la synchronisation générale (qui pouvait écraser l'entrée avant son envoi).
    expressApp.post('/api/cloture/archiver', (req, res) => {
      try {
        const entree = req.body || {};
        if (!entree.id) return res.status(400).json({ ok: false, error: 'id manquant' });
        state.clotureHistorique = state.clotureHistorique || [];
        const idx = state.clotureHistorique.findIndex(function (h) { return h.id === entree.id; });
        if (idx >= 0) state.clotureHistorique[idx] = entree; else state.clotureHistorique.unshift(entree);
        saveState(state);
        diffuserEtat();
        res.json({ ok: true });
      } catch (e) {
        console.error('[FSS-CAISSE] Erreur archivage clôture :', e);
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // Le statut des tables (Libre/Occupée/Réservée) est désormais géré via
    // les routes dédiées /api/tables/* ci-dessous, plus robuste qu'une
    // comparaison d'horodatages entre appareils (tsModif), qui restait
    // fragile dès qu'une horloge était mal réglée quelque part.

    // Les bons de commande cuisine et bilans de clôture (printBatches) sont
    // désormais gérés via la route dédiée /api/printbatches/ajouter
    // ci-dessous, plus fiable qu'une fusion par horodatage.

    // ---- Catalogue d'articles : ajout / modification / suppression ARTICLE PAR ARTICLE ----
    // Un seul article ajouté, importé ou modifié est enregistré tout de suite sur le serveur,
    // FUSIONNÉ avec la liste déjà enregistrée : un poste dont la copie du catalogue est en retard
    // ne peut plus écraser les autres articles. Les suppressions sont mémorisées (artsSupprimes).
    expressApp.post('/api/arts/maj', (req, res) => {
      try {
        const upserts = Array.isArray(req.body && req.body.upserts) ? req.body.upserts : [];
        const supprimes = Array.isArray(req.body && req.body.supprimes) ? req.body.supprimes : [];
        state.arts = Array.isArray(state.arts) ? state.arts : [];
        const supp = new Set((state.artsSupprimes || []).concat(supprimes));
        const index = {};
        state.arts.forEach(function (a, i) { index[a.id] = i; });
        upserts.forEach(function (a) {
          if (!a || a.id === undefined || a.id === null) return;
          supp.delete(a.id);
          if (index[a.id] !== undefined) state.arts[index[a.id]] = a;
          else { index[a.id] = state.arts.length; state.arts.push(a); }
        });
        const aSupprimer = new Set(supprimes);
        if (aSupprimer.size) state.arts = state.arts.filter(function (a) { return !aSupprimer.has(a.id); });
        state.artsSupprimes = Array.from(supp).slice(-20000);
        state.artsUpdatedAt = Math.max(Date.now(), (state.artsUpdatedAt || 0) + 1);
        saveState(state);
        diffuserEtat();
        ecrireJournal('Catalogue : ' + upserts.length + ' article(s) ajouté(s)/modifié(s), ' + aSupprimer.size + ' supprimé(s) — total ' + state.arts.length);
        res.json({ ok: true, total: state.arts.length });
      } catch (err) {
        console.error('[FSS-CAISSE] Erreur mise à jour du catalogue :', err);
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    expressApp.post('/api/state', (req, res) => {
      try {
        const nouvelEtat = req.body;
        // cmdAttente n'est plus jamais accepté depuis cette route générique —
        // on garde toujours la version déjà connue du serveur, gérée à part
        // via les routes /api/cmdattente/*.
        nouvelEtat.cmdAttente = state.cmdAttente || [];
        // Même chose pour les tables — gérées à part via /api/tables/*, pour
        // ne plus jamais dépendre d'une comparaison d'horodatages entre
        // appareils.
        nouvelEtat.tables = state.tables || [];
        // printBatches n'est plus jamais accepté depuis cette route
        // générique — géré exclusivement via /api/printbatches/ajouter,
        // pour la même raison que cmdAttente et tables : ne plus jamais
        // dépendre d'une synchronisation débouncée qui pouvait manquer un
        // bon fraîchement créé.
        nouvelEtat.printBatches = state.printBatches || [];
        // Même principe pour l'historique des clôtures : géré par /api/cloture/archiver.
        nouvelEtat.clotureHistorique = state.clotureHistorique || [];
        // Le catalogue d'articles n'est accepté que s'il est réellement plus
        // récent que celui déjà connu du serveur — sinon on garde la dernière
        // vraie mise à jour. Sans ça, un poste avec une version un peu
        // ancienne du catalogue (pas encore reçu un ajout/modif fait
        // ailleurs) pouvait écraser un article tout juste mis à jour.
        const ancienHorodatageArts = (state && state.artsUpdatedAt) || 0;
        const nouvelHorodatageArts = nouvelEtat.artsUpdatedAt || 0;
        if (ancienHorodatageArts > nouvelHorodatageArts) {
          nouvelEtat.arts = state.arts;
          nouvelEtat.artsUpdatedAt = ancienHorodatageArts;
        }
        // Même quand la liste reçue est acceptée, on ne perd jamais un article enregistré sur le
        // serveur que ce poste ne connaissait pas encore (sauf s'il a été supprimé exprès).
        nouvelEtat.artsSupprimes = state.artsSupprimes || [];
        if (Array.isArray(nouvelEtat.arts) && Array.isArray(state.arts) && nouvelEtat.arts !== state.arts) {
          const connus = new Set(nouvelEtat.arts.map(function (a) { return a.id; }));
          const supprimes = new Set(nouvelEtat.artsSupprimes);
          const manquants = state.arts.filter(function (a) { return !connus.has(a.id) && !supprimes.has(a.id); });
          if (manquants.length) {
            nouvelEtat.arts = nouvelEtat.arts.concat(manquants);
            ecrireJournal('Catalogue : ' + manquants.length + ' article(s) du serveur conservé(s) (le poste ne les connaissait pas)');
          }
        }
        // Comptes utilisateurs : un poste en retard (ancienne copie des comptes)
        // ne doit JAMAIS écraser un changement plus récent (mot de passe,
        // droits, nouveau compte). Chaque modification incrémente usersRev ;
        // le serveur refuse une liste dont le numéro est plus ancien.
        const revServeur = (state && state.usersRev) || 0;
        const revRecue = nouvelEtat.usersRev || 0;
        if (state && state.users && revRecue < revServeur) {
          nouvelEtat.users = state.users;
          nouvelEtat.nextUserId = state.nextUserId;
          nouvelEtat.usersRev = revServeur;
          ecrireJournal('Comptes : liste reçue plus ancienne (rév. ' + revRecue + ' < ' + revServeur + ') — ignorée, version du serveur conservée');
        }
        state = nouvelEtat;
        saveState(state);
        diffuserEtat();
        res.json({ ok: true });
      } catch (e) {
        console.error('[FSS-CAISSE] Erreur lors de l\'enregistrement d\'un changement :', e);
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // ---- Routes Airtel Money ----
    expressApp.get('/api/airtel/config-status', (req, res) => {
      const cfg = loadAirtelConfig();
      res.json({ configured: !!(cfg.clientId && cfg.clientSecret), environment: cfg.environment || 'staging' });
    });

    expressApp.post('/api/airtel/save-config', (req, res) => {
      const { clientId, clientSecret, country, currency, environment } = req.body || {};
      saveAirtelConfig({
        clientId: clientId || '', clientSecret: clientSecret || '',
        country: country || 'GA', currency: currency || 'XAF',
        environment: environment === 'production' ? 'production' : 'staging'
      });
      res.json({ ok: true });
    });

    expressApp.post('/api/airtel/collect', async (req, res) => {
      try {
        const cfg = loadAirtelConfig();
        if (!cfg.clientId || !cfg.clientSecret) {
          return res.status(400).json({ ok: false, error: "Airtel Money n'est pas encore configuré (Paramètres > Paiement Mobile)." });
        }
        const { phone, amount, reference } = req.body || {};
        if (!phone || !amount) return res.status(400).json({ ok: false, error: 'Numéro et montant requis.' });
        const base = cfg.environment === 'production' ? 'https://openapi.airtel.africa' : 'https://openapiuat.airtel.africa';
        const token = await airtelGetToken(cfg);
        const txRef = reference || ('FSS-' + Date.now());
        const collectRes = await fetch(base + '/merchant/v1/payments/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
            'X-Country': cfg.country || 'GA',
            'X-Currency': cfg.currency || 'XAF'
          },
          body: JSON.stringify({
            reference: 'FSS-CAISSE',
            subscriber: { country: cfg.country || 'GA', currency: cfg.currency || 'XAF', msisdn: phone },
            transaction: { amount: amount, country: cfg.country || 'GA', currency: cfg.currency || 'XAF', id: txRef }
          })
        });
        const collectData = await collectRes.json().catch(function () { return {}; });
        if (!collectRes.ok) {
          return res.status(502).json({ ok: false, error: (collectData && collectData.message) || 'Échec de la demande de paiement Airtel Money.' });
        }
        res.json({ ok: true, transactionId: txRef });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message || 'Erreur Airtel Money' });
      }
    });

    expressApp.get('/api/airtel/status/:transactionId', async (req, res) => {
      try {
        const cfg = loadAirtelConfig();
        if (!cfg.clientId || !cfg.clientSecret) return res.status(400).json({ ok: false, error: 'Non configuré' });
        const base = cfg.environment === 'production' ? 'https://openapi.airtel.africa' : 'https://openapiuat.airtel.africa';
        const token = await airtelGetToken(cfg);
        const statusRes = await fetch(base + '/standard/v1/payments/' + encodeURIComponent(req.params.transactionId), {
          headers: {
            'Authorization': 'Bearer ' + token,
            'X-Country': cfg.country || 'GA',
            'X-Currency': cfg.currency || 'XAF'
          }
        });
        const statusData = await statusRes.json().catch(function () { return {}; });
        var statusCode = statusData && statusData.data && statusData.data.transaction && statusData.data.transaction.status;
        res.json({ ok: true, status: statusCode || 'PENDING', raw: statusData });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message || 'Erreur Airtel Money' });
      }
    });

    // ---- Paiement Mobile Money PVIT (Airtel Money / Moov Money) via le relais FSS-PAY ----
    // La clé du terminal est stockée ici, sur le serveur de caisse, et n'est JAMAIS envoyée au
    // navigateur : les postes appellent /api/pvit/proxy/..., que ce serveur relaie vers FSS-PAY.
    // Écrit sans fetch ni opérateurs récents (?. ??) : doit tourner aussi sur le Node 12 des TPE.
    function loadPvitConfig() {
      try {
        if (fs.existsSync(pvitConfigFile)) return JSON.parse(fs.readFileSync(pvitConfigFile, 'utf8'));
      } catch (e) { /* ignore */ }
      return { relais: '', cle: '' };
    }
    function savePvitConfig(cfg) {
      const tmp = pvitConfigFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
      fs.renameSync(tmp, pvitConfigFile);
    }
    function appelRelaisPvit(cfg, methode, chemin, corps) {
      return new Promise(function (resolve) {
        var url;
        try { url = new URL(cfg.relais.replace(/\/+$/, '') + '/api' + chemin); }
        catch (e) { return resolve({ status: 400, body: { ok: false, erreur: 'Adresse du relais FSS-PAY invalide' } }); }
        var lib = url.protocol === 'https:' ? require('https') : require('http');
        var donnees = corps ? Buffer.from(JSON.stringify(corps)) : null;
        var entetes = { 'Accept': 'application/json', 'X-FSS-Cle': cfg.cle };
        if (donnees) { entetes['Content-Type'] = 'application/json'; entetes['Content-Length'] = donnees.length; }
        var req = lib.request(url, { method: methode, headers: entetes, timeout: 30000 }, function (rep) {
          var morceaux = [];
          rep.on('data', function (c) { morceaux.push(c); });
          rep.on('end', function () {
            var texte = Buffer.concat(morceaux).toString('utf8');
            var json;
            try { json = JSON.parse(texte); } catch (e) { json = { ok: false, erreur: 'Réponse invalide du relais FSS-PAY' }; }
            resolve({ status: rep.statusCode || 502, body: json });
          });
        });
        req.on('timeout', function () { req.destroy(new Error('délai dépassé')); });
        req.on('error', function (e) {
          resolve({ status: 502, body: { ok: false, erreur: 'Relais FSS-PAY injoignable (' + e.message + '). Vérifiez la connexion Internet.' } });
        });
        if (donnees) req.write(donnees);
        req.end();
      });
    }

    expressApp.get('/api/pvit/config-status', (req, res) => {
      const cfg = loadPvitConfig();
      res.json({ configured: !!(cfg.relais && cfg.cle), relais: cfg.relais || '', cleFin: cfg.cle ? String(cfg.cle).slice(-4) : '' });
    });

    expressApp.post('/api/pvit/save-config', (req, res) => {
      const b = req.body || {};
      const actuel = loadPvitConfig();
      const relais = String(b.relais || '').trim().replace(/\/+$/, '');
      if (relais && !/^https?:\/\//i.test(relais)) return res.status(400).json({ ok: false, erreur: 'L\'adresse doit commencer par https://' });
      // Clé laissée vide = on garde la clé déjà enregistrée
      const cle = String(b.cle || '').trim() || actuel.cle || '';
      savePvitConfig({ relais: relais, cle: cle });
      ecrireJournal('PVIT : configuration du relais Mobile Money mise à jour (' + relais + ')');
      res.json({ ok: true });
    });

    const PVIT_CHEMINS = /^\/(sante|kyc|frais|solde|paiements(\/[A-Za-z0-9_-]{1,40})?)$/;
    expressApp.all('/api/pvit/proxy/*', async (req, res) => {
      const chemin = '/' + req.params[0];
      if (!PVIT_CHEMINS.test(chemin) || (req.method !== 'GET' && req.method !== 'POST')) {
        return res.status(404).json({ ok: false, erreur: 'Route Mobile Money inconnue' });
      }
      const cfg = loadPvitConfig();
      if (!cfg.relais || !cfg.cle) {
        return res.status(400).json({ ok: false, erreur: 'Mobile Money non configuré (Paramètres > Paiement Mobile).' });
      }
      const i = req.originalUrl.indexOf('?');
      const query = i >= 0 ? req.originalUrl.slice(i) : '';
      const r = await appelRelaisPvit(cfg, req.method, chemin + query, req.method === 'POST' ? (req.body || {}) : null);
      if (req.method === 'POST' && chemin === '/paiements' && r.body && r.body.paiement) {
        ecrireJournal('PVIT : paiement ' + r.body.paiement.reference + ' ' + r.body.paiement.montant + ' F -> ' + r.body.paiement.statut);
      }
      res.status(r.status).json(r.body);
    });

    io.on('connection', (socket) => {
      try {
        socket.emit('state:changed', state);
      } catch (e) {
        console.error('[FSS-CAISSE] Erreur lors de la connexion d\'un poste :', e);
      }
    });

    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
};
