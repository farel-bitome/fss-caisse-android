const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
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

    function loadState() {
      let state;
      let sourceUtilisee = 'principale';
      try {
        if (fs.existsSync(dataFile)) {
          state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        }
      } catch (e) {
        // Fichier principal corrompu (ex: l'app a planté en pleine écriture) —
        // avant d'abandonner et de repartir sur des données vierges (ce qui
        // effaçait TOUT : commandes en attente, ventes...), on tente d'abord
        // de récupérer la dernière copie de secours valide.
        console.error('Fichier de données principal illisible :', e.message);
        try {
          if (fs.existsSync(backupDataFile)) {
            state = JSON.parse(fs.readFileSync(backupDataFile, 'utf8'));
            sourceUtilisee = 'copie de secours';
            console.log('Récupéré depuis la copie de secours (data.backup.json).');
          }
        } catch (e2) {
          console.error('Copie de secours également illisible :', e2.message);
        }
      }
      if (!state) {
        console.error('Aucune donnée récupérable — démarrage sur les données par défaut (catalogue de base uniquement).');
        return JSON.parse(fs.readFileSync(defaultFile, 'utf8'));
      }
      if (sourceUtilisee === 'copie de secours') {
        // Réécrit immédiatement le fichier principal avec les données
        // récupérées, pour que la copie corrompue ne traîne pas.
        saveState(state);
      }
      // Migration unique : remplace le catalogue d'articles par le nouveau menu,
      // sans toucher au reste des données déjà enregistrées (clients, ventes,
      // personnel, etc.) — ne s'exécute qu'une seule fois grâce au marqueur.
      if (!state.menuMigratedV2) {
        try {
          const defaults = JSON.parse(fs.readFileSync(defaultFile, 'utf8'));
          state.arts = defaults.arts;
          state.menuMigratedV2 = true;
          saveState(state);
          console.log('Migration : catalogue d\'articles mis à jour (' + defaults.arts.length + ' articles).');
        } catch (e) {
          console.error('Erreur pendant la migration du catalogue d\'articles :', e.message);
        }
      }
      // Migration unique : corrige la liste des catégories (Paramètres) pour
      // qu'elle corresponde réellement aux catégories utilisées par les
      // articles — l'ancienne liste de démonstration ('Boissons', 'Bières'...)
      // ne correspondait à aucun article réel, ce qui rendait notamment les
      // réglages "gestion de stock par catégorie" inopérants (aucune
      // correspondance exacte possible).
      if (!state.categoriesMigratedV1) {
        try {
          const catsReelles = Array.from(new Set((state.arts || []).map(a => a.cat).filter(Boolean))).sort();
          if (catsReelles.length) {
            state.categories = catsReelles;
          }
          state.categoriesMigratedV1 = true;
          saveState(state);
          console.log('Migration : liste des catégories corrigée (' + catsReelles.length + ' catégories).');
        } catch (e) {
          console.error('Erreur pendant la migration des catégories :', e.message);
        }
      }
      // Migration unique : remplace l'ancienne liste de tables de démonstration
      // (8 tables) par les 400 tables demandées, toutes "Libre" par défaut —
      // à l'utilisateur de marquer ensuite lui-même celles qui sont réservées
      // ou occupées, via le formulaire d'édition d'une table.
      if (!state.tablesMigratedV1) {
        try {
          const defaults = JSON.parse(fs.readFileSync(defaultFile, 'utf8'));
          state.tables = defaults.tables;
          state.tablesMigratedV1 = true;
          saveState(state);
          console.log('Migration : ' + defaults.tables.length + ' tables mises en place (toutes libres).');
        } catch (e) {
          console.error('Erreur pendant la migration des tables :', e.message);
        }
      }
      return state;
    }

    function saveState(state) {
      const json = JSON.stringify(state, null, 2);
      // Garde une copie de secours du dernier état VALIDE avant d'écraser —
      // sert de filet de récupération si jamais la prochaine écriture est
      // interrompue par un plantage.
      try {
        if (fs.existsSync(dataFile)) {
          fs.copyFileSync(dataFile, backupDataFile);
        }
      } catch (e) {
        console.error('Impossible de mettre à jour la copie de secours :', e.message);
      }
      // Écriture atomique : on écrit d'abord dans un fichier temporaire, puis
      // on le renomme à la place du vrai fichier. Un "rename" est atomique au
      // niveau du système de fichiers — soit il réussit entièrement, soit le
      // fichier d'origine reste intact. Contrairement à une écriture directe,
      // un plantage en plein milieu ne peut plus jamais laisser le fichier
      // de données dans un état à moitié écrit (corrompu).
      const tmpFile = dataFile + '.tmp';
      fs.writeFileSync(tmpFile, json);
      fs.renameSync(tmpFile, dataFile);
    }

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

    expressApp.use(function (req, res, next) {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,POST');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });
    expressApp.use(express.json({ limit: '10mb' }));
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
        io.emit('state:changed', state);
        ecrireJournal('Commande en attente ajoutée : ' + req.body.id + ' (' + req.body.tableNom + ', ' + req.body.total + ' FCFA) — total actuel : ' + state.cmdAttente.length);
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
        io.emit('state:changed', state);
        ecrireJournal('Commande en attente retirée : ' + req.body.id + ' — total actuel : ' + state.cmdAttente.length);
        res.json({ ok: true });
      } catch (e) {
        console.error('[FSS-CAISSE] Erreur suppression commande en attente :', e);
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // Même problème, mais pour le STATUT des tables (Libre/Occupée/Réservée) :
    // un poste avec une version en retard pouvait écraser le statut "Occupée"
    // qu'un autre poste venait tout juste de définir, faisant "se libérer
    // toute seule" une table en pleine utilisation. Fusion par numéro de
    // table : on garde toujours la modification la PLUS RÉCENTE (grâce à
    // tsModif), peu importe l'ordre d'arrivée des synchronisations.
    function fusionnerTables(ancien, nouveau) {
      var parNumero = {};
      (ancien || []).forEach(function (t) { parNumero[t.n] = t; });
      (nouveau || []).forEach(function (t) {
        var existant = parNumero[t.n];
        if (!existant) { parNumero[t.n] = t; return; }
        var tsExistant = existant.tsModif || 0;
        var tsNouveau = t.tsModif || 0;
        // Garde la version la plus récente ; à égalité (ou aucun horodatage
        // sur les deux, ex: anciennes données), la version reçue l'emporte.
        parNumero[t.n] = (tsNouveau >= tsExistant) ? t : existant;
      });
      return Object.keys(parNumero).map(function (k) { return parNumero[k]; }).sort(function (a, b) { return a.n - b.n; });
    }

    expressApp.post('/api/state', (req, res) => {
      try {
        const nouvelEtat = req.body;
        // cmdAttente n'est plus jamais accepté depuis cette route générique —
        // on garde toujours la version déjà connue du serveur, gérée à part
        // via les routes /api/cmdattente/*.
        nouvelEtat.cmdAttente = state.cmdAttente || [];
        if (state && Array.isArray(state.tables) && Array.isArray(nouvelEtat.tables)) {
          nouvelEtat.tables = fusionnerTables(state.tables, nouvelEtat.tables);
        }
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
        state = nouvelEtat;
        saveState(state);
        io.emit('state:changed', state);
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
