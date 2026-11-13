const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { Server } = require('socket.io');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Sécurité : mots de passe hachés (scrypt + sel), jamais renvoyés aux postes.
// ---------------------------------------------------------------------------
function hacherMdp(mdp) {
  const sel = crypto.randomBytes(16).toString('hex');
  return 'scrypt$' + sel + '$' + crypto.scryptSync(String(mdp), sel, 32).toString('hex');
}
function egalConstant(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function verifierHash(mdp, stocke) {
  try {
    const p = String(stocke).split('$');
    if (p[0] !== 'scrypt' || p.length !== 3) return false;
    const h = crypto.scryptSync(String(mdp), p[1], 32);
    const attendu = Buffer.from(p[2], 'hex');
    return attendu.length === h.length && crypto.timingSafeEqual(h, attendu);
  } catch (e) { return false; }
}
function mdpCorrect(u, mdp) {
  if (!u || mdp === undefined || mdp === null || mdp === '') return false;
  if (u.mdpHash) return verifierHash(mdp, u.mdpHash);
  if (typeof u.mdp === 'string' && u.mdp !== '') return egalConstant(u.mdp, mdp);
  return false;
}
// Anciennes bases : mots de passe en clair -> hachés une fois pour toutes.
function migrerMdp(st) {
  (st && Array.isArray(st.users) ? st.users : []).forEach((u) => {
    if (!u) return;
    if (typeof u.mdp === 'string' && u.mdp !== '' && !u.mdpHash) u.mdpHash = hacherMdp(u.mdp);
    delete u.mdp;
  });
}
function etatPublic(st) {
  const c = Object.assign({}, st);
  c.users = (st.users || []).map((u) => { const x = Object.assign({}, u); delete x.mdp; delete x.mdpHash; return x; });
  delete c.razCles;
  return c;
}
function etatAnonyme(st) {
  return { _public: true, logo: st.logo || null, etab: st.etab || null };
}

// ---------------------------------------------------------------------------
// Noms saisis (articles, clients, tables...) : on neutralise < > " à l'enregistrement,
// pour qu'aucun nom ne puisse injecter de code dans les écrans ou les impressions.
// ---------------------------------------------------------------------------
const CLES_NON_ASSAINIES = { logo: 1, printBatches: 1, mdp: 1, mdpHash: 1 };
function assainir(v) {
  if (typeof v === 'string') return v.replace(/</g, '‹').replace(/>/g, '›').replace(/"/g, '″');
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = assainir(v[i]); return v; }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) { if (!CLES_NON_ASSAINIES[k]) v[k] = assainir(v[k]); }
    return v;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Tickets : le serveur est l'autorité (stock, numéros, annulations).
// ---------------------------------------------------------------------------
function stockGereSrv(a, catActive) {
  if (!a || a.alerte === false) return false;
  if (catActive && catActive[a.cat] === false && !a.stkRemis) return false;
  return true;
}
function cleDoublon(t) { return [t.ts, t.ttc, t.caissier, t.tbl].join('|'); }
function appliquerStockTicket(t, arts, catActive) {
  const parId = {};
  arts.forEach((a) => { parId[a.id] = a; });
  const ajuster = (sens) => {
    (t.items || []).forEach((it) => {
      const a = it && it.id != null ? parId[it.id] : null;
      if (a && stockGereSrv(a, catActive)) a.stk = (Number(a.stk) || 0) + sens * (Number(it.qty) || 0);
    });
  };
  if (!t._stkSrv) {
    if (t.stat !== 'Annulé') ajuster(-1); else t._stkRendu = true;
    t._stkSrv = true;
  } else if (t.stat === 'Annulé' && !t._stkRendu) {
    ajuster(+1);
    t._stkRendu = true;
  }
}

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
    const dossierSauvegardes = path.join(userDataDir, 'sauvegardes');
    let derniereCopie = 0;
    // Sauvegardes : (1) une copie « data.backup.json » au plus toutes les 10 minutes — avant, elle était
    // écrasée à CHAQUE écriture, donc une seule mauvaise écriture détruisait aussi la copie de secours ;
    // (2) un instantané par jour conservé 14 jours dans le dossier « sauvegardes ».
    function sauvegarderAvantEcriture() {
      try {
        if (!fs.existsSync(dataFile)) return;
        const t = Date.now();
        if (t - derniereCopie > 10 * 60 * 1000) { fs.copyFileSync(dataFile, backupDataFile); derniereCopie = t; }
        fs.mkdirSync(dossierSauvegardes, { recursive: true });
        const jour = new Date().toISOString().slice(0, 10);
        const f = path.join(dossierSauvegardes, 'data-' + jour + '.json');
        if (!fs.existsSync(f)) {
          fs.copyFileSync(dataFile, f);
          const anciens = fs.readdirSync(dossierSauvegardes).filter(function (n) { return /^data-\d{4}-\d{2}-\d{2}\.json$/.test(n); }).sort();
          while (anciens.length > 14) { try { fs.unlinkSync(path.join(dossierSauvegardes, anciens.shift())); } catch (e) { break; } }
        }
      } catch (e) { /* la sauvegarde ne doit jamais bloquer une vente */ }
    }
    function ecrireEtat(state) {
      const json = JSON.stringify(state);
      const tmpFile = dataFile + '.tmp';
      // Écriture atomique (fichier temporaire + rename : un plantage en plein milieu ne peut jamais
      // laisser un fichier de données à moitié écrit).
      sauvegarderAvantEcriture();
      return fsp.writeFile(tmpFile, json)
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
        sauvegarderAvantEcriture();
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
    migrerMdp(state);
    assainir(state);
    // Tickets déjà présents : leur stock est considéré comme déjà appliqué (jamais retraité).
    (Array.isArray(state.txs) ? state.txs : []).forEach((t) => {
      if (!t) return;
      t._stkSrv = true;
      if (t.stat === 'Annulé') t._stkRendu = true;
    });

    const expressApp = express();
    const server = http.createServer(expressApp);
    const io = new Server(server);
    // Diffusion de l'état regroupée : plusieurs changements rapprochés = UN seul envoi (au lieu d'un envoi complet
    // par changement). Évite de saturer le processus principal (et donc de figer la fenêtre) quand l'historique grossit.
    let diffusionTimer = null;
    function diffuserEtat() {
      if (diffusionTimer) return;
      diffusionTimer = setTimeout(() => { diffusionTimer = null; try { io.to('auth').emit('state:changed', etatPublic(state)); } catch (e) {} }, 150);
    }

    // Plus de CORS ouvert à tous : une page web quelconque ne peut plus lire les données.
    // Seul /api/ping (aucune donnée) reste lisible de l'extérieur (test d'adresse du serveur).
    expressApp.get('/api/ping', function (req, res) {
      res.header('Access-Control-Allow-Origin', '*');
      res.json({ ok: true });
    });
    // 'risque' : le corps contient < > ou un guillemet échappé -> seulement alors on parcourt les données pour les assainir
    // (évite de reparcourir tout l'état à chaque envoi : le serveur tourne dans le processus principal de l'application).
    expressApp.use(express.json({ limit: '10mb', verify: function (req, res, buf) { try { req.risque = /[<>]|\\"/.test(buf.toString('latin1')); } catch (e) { req.risque = true; } } }));
    // ---- Sessions : un jeton est délivré à la connexion (mot de passe vérifié par le serveur) ----
    const sessions = new Map();
    const DUREE_SESSION = 12 * 3600 * 1000;
    function estLocal(req) {
      const a = (req.socket && req.socket.remoteAddress) || '';
      return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
    }
    function sessionDe(req) {
      const t = req.headers['x-fss-token'];
      const s = t && sessions.get(String(t));
      if (!s) return null;
      if (Date.now() > s.exp) { sessions.delete(String(t)); return null; }
      s.exp = Date.now() + DUREE_SESSION;
      return s;
    }
    function acteurDe(req) {
      const s = sessionDe(req);
      return s ? ((state.users || []).find((u) => u && u.id === s.uid) || null) : null;
    }
    // Le poste Serveur lui-même (127.0.0.1) est de confiance ; tout autre appareil doit être connecté.
    function requeteAutorisee(req) { return estLocal(req) || !!sessionDe(req); }
    function estAdminReq(req) {
      const u = acteurDe(req);
      if (u) return !!(u.super || u.full);
      return estLocal(req) && !req.headers['x-fss-token'];
    }
    const essaisLogin = {};
    function limiteur(table, ip, max, blocageMs) {
      const e = table[ip] || { n: 0, bloque: 0 };
      table[ip] = e;
      if (Date.now() < e.bloque) return { bloque: true, e };
      return { bloque: false, e, echec() { e.n++; if (e.n >= max) { e.n = 0; e.bloque = Date.now() + blocageMs; } }, ok() { delete table[ip]; } };
    }
    expressApp.post('/api/login', (req, res) => {
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || '?';
      const l = limiteur(essaisLogin, ip, 8, 30000);
      if (l.bloque) return res.status(429).json({ ok: false, error: 'Trop d\'essais, patientez 30 secondes' });
      const nom = String((req.body && req.body.nom) || '').trim().toLowerCase();
      const mdp = String((req.body && req.body.mdp) || '');
      const u = (state.users || []).filter((x) => x && String(x.nom).toLowerCase() === nom).find((x) => mdpCorrect(x, mdp));
      if (!u) { l.echec(); return res.json({ ok: false }); }
      l.ok();
      const now = Date.now();
      sessions.forEach((v, k) => { if (now > v.exp) sessions.delete(k); });
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, { uid: u.id, exp: now + DUREE_SESSION });
      const pub = Object.assign({}, u); delete pub.mdp; delete pub.mdpHash;
      ecrireJournal('Connexion : ' + u.nom + ' (' + ip + ')');
      res.json({ ok: true, token, user: pub });
    });
    // Confirmation du mot de passe de l'utilisateur connecté (actions sensibles : RAZ, suppression du catalogue...).
    const essaisConfirm = {};
    expressApp.post('/api/verif-mdp', (req, res) => {
      const u = acteurDe(req);
      if (!u) return res.status(401).json({ ok: false });
      const l = limiteur(essaisConfirm, String(u.id), 6, 30000);
      if (l.bloque) return res.status(429).json({ ok: false });
      const ok = mdpCorrect(u, String((req.body && req.body.mdp) || ''));
      if (ok) l.ok(); else l.echec();
      res.json({ ok });
    });
    // Vérification d'un compte admin / super-admin pour l'accès technicien des postes clients (rien n'est mémorisé côté client).
    const essaisVerif = {};
    expressApp.post('/api/verif-admin', (req, res) => {
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || '?';
      const l = limiteur(essaisVerif, ip, 5, 30000);
      if (l.bloque) return res.status(429).json({ ok: false });
      const nom = String((req.body && req.body.nom) || '').trim().toLowerCase();
      const mdp = String((req.body && req.body.mdp) || '');
      const ok = mdp !== '' && (state.users || []).some(u => u && (u.super || u.full) && mdpCorrect(u, mdp) && (!nom || String(u.nom).toLowerCase() === nom));
      if (ok) { l.ok(); return res.json({ ok: true }); }
      l.echec();
      res.json({ ok: false });
    });
    // Tout le reste de /api exige une session valide (sauf poste Serveur local).
    expressApp.use('/api', function (req, res, next) {
      if (req.method === 'GET' && req.path === '/state') return next(); // vue publique si non connecté
      if (requeteAutorisee(req)) {
        if (req.method === 'POST' && req.body && req.risque && !/^\/(printbatches|airtel|pvit)/.test(req.path)) assainir(req.body);
        return next();
      }
      res.status(401).json({ ok: false, error: 'non autorisé' });
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
      if (!requeteAutorisee(req)) return res.json(etatAnonyme(state));
      res.json(etatPublic(state));
    });

    // Remise à zéro de la caisse : route dédiée (les tickets ne sont jamais supprimés par un envoi d'état).
    expressApp.post('/api/raz', (req, res) => {
      try {
        if (!estAdminReq(req)) return res.status(403).json({ ok: false, error: 'réservé aux administrateurs' });
        const caisse = String((req.body && req.body.caisse) || '');
        const liste = Array.isArray(state.txs) ? state.txs : [];
        const retires = liste.filter((t) => !caisse || t.caisse === caisse);
        state.razCles = (state.razCles || []).concat(retires.map(cleDoublon)).slice(-20000);
        state.txs = liste.filter((t) => caisse && t.caisse !== caisse);
        if (!caisse) { state.prls = []; state.entrees = []; }
        saveState(state);
        diffuserEtat();
        ecrireJournal('RAZ caisse ' + (caisse || '(toutes)') + ' — ' + retires.length + ' ticket(s) retiré(s)');
        res.json({ ok: true, retires: retires.length });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
        io.to('auth').emit('print:error', req.body || {});
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
        // Garde-fou : un corps vide / invalide / sans catalogue ne doit JAMAIS remplacer la base.
        if (!nouvelEtat || typeof nouvelEtat !== 'object' || Array.isArray(nouvelEtat) || !Array.isArray(nouvelEtat.arts) || !Array.isArray(nouvelEtat.txs)) {
          ecrireJournal('État reçu REFUSÉ (structure invalide) — base conservée');
          return res.status(400).json({ ok: false, error: 'état invalide' });
        }
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
        // ---- Comptes : mots de passe hachés, droits protégés ----
        const acteur = acteurDe(req);
        const admin = estAdminReq(req);
        const anciens = Array.isArray(state.users) ? state.users : [];
        if (admin) {
          (Array.isArray(nouvelEtat.users) ? nouvelEtat.users : []).forEach((u) => {
            if (!u) return;
            const ancien = anciens.find((x) => x && x.id === u.id);
            if (typeof u.mdp === 'string' && u.mdp !== '' && !(ancien && ancien.super)) u.mdpHash = hacherMdp(u.mdp);
            else u.mdpHash = ancien ? ancien.mdpHash : undefined;
            delete u.mdp;
            if (u.mdpHash === undefined) delete u.mdpHash;
          });
        } else {
          // Un compte non administrateur ne peut ni créer de compte ni changer de droits : seul son propre mot de passe.
          const recu = acteur && (Array.isArray(nouvelEtat.users) ? nouvelEtat.users : []).find((x) => x && x.id === acteur.id);
          nouvelEtat.users = anciens;
          nouvelEtat.nextUserId = state.nextUserId;
          nouvelEtat.usersRev = state.usersRev;
          if (acteur && !acteur.super && recu && typeof recu.mdp === 'string' && recu.mdp.length >= 3) {
            const cible = anciens.find((x) => x && x.id === acteur.id);
            if (cible) { cible.mdpHash = hacherMdp(recu.mdp); cible.doitChangerMdp = false; }
          }
        }
        // ---- Stock : le serveur est l'autorité (une vente d'un autre poste n'est jamais écrasée) ----
        const artsServeur = {};
        (Array.isArray(state.arts) ? state.arts : []).forEach((a) => { if (a) artsServeur[a.id] = a; });
        nouvelEtat.arts = nouvelEtat.arts.map((a) => {
          const c = Object.assign({}, a);
          const sv = artsServeur[a.id];
          if (sv && typeof sv.stk === 'number') c.stk = sv.stk;
          return c;
        });
        // ---- Tickets : fusion (jamais perdus, jamais doublonnés), numéros uniques, stock appliqué une seule fois ----
        const parId = new Map();
        const parCle = new Map();
        (Array.isArray(state.txs) ? state.txs : []).forEach((t) => { if (t && t.id != null) { parId.set(t.id, t); parCle.set(cleDoublon(t), t); } });
        const cles = new Set(state.razCles || []);
        const utilises = new Set(parId.keys());
        let compteur = Math.max(Number(state.nextTk) || 1, Number(nouvelEtat.nextTk) || 1);
        parId.forEach((t, id) => { const n = parseInt(String(id).replace(/\D/g, ''), 10); if (n >= compteur) compteur = n + 1; });
        const vus = new Set();
        const fusion = [];
        (nouvelEtat.txs || []).forEach((t) => {
          if (!t || t.id == null) return;
          const sv = parId.get(t.id);
          if (sv && (!t.ts || sv.ts === t.ts)) {
            if (vus.has(sv)) return;
            vus.add(sv);
            const m = Object.assign({}, t);
            delete m._stkSrv; delete m._stkRendu;
            if (sv._stkSrv) m._stkSrv = true;
            if (sv._stkRendu) m._stkRendu = true;
            if (sv.stat === 'Annulé') ['stat', 'annuleMotif', 'annulePar', 'annuleLe', 'stkRemis'].forEach((k) => { if (sv[k] !== undefined) m[k] = sv[k]; });
            if (sv.creditPaye === true && m.creditPaye !== true) ['creditPaye', 'pay', 'recu', 'rendu', 'creditRegleLe', 'creditRegleePar'].forEach((k) => { if (sv[k] !== undefined) m[k] = sv[k]; });
            fusion.push(m);
            return;
          }
          const k = cleDoublon(t);
          if (parCle.has(k)) { const sv2 = parCle.get(k); if (!vus.has(sv2)) { vus.add(sv2); fusion.push(sv2); } return; }
          if (cles.has(k)) return; // ticket effacé par une remise à zéro : un poste en retard ne le ressuscite pas
          const n = Object.assign({}, t);
          delete n._stkSrv; delete n._stkRendu;
          if (utilises.has(n.id)) {
            while (utilises.has('TK-' + ('000' + compteur).slice(-4))) compteur++;
            ecrireJournal('Numéro de ticket en double (' + n.id + ') — renuméroté TK-' + ('000' + compteur).slice(-4));
            n.id = 'TK-' + ('000' + compteur).slice(-4);
          }
          utilises.add(n.id);
          parCle.set(k, n);
          fusion.push(n);
        });
        (Array.isArray(state.txs) ? state.txs : []).forEach((t) => { if (t && !vus.has(t)) fusion.push(t); });
        fusion.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        fusion.forEach((t) => {
          appliquerStockTicket(t, nouvelEtat.arts, nouvelEtat.categoryAlerteActive);
          const n = parseInt(String(t.id).replace(/\D/g, ''), 10);
          if (n >= compteur) compteur = n + 1;
        });
        nouvelEtat.txs = fusion;
        nouvelEtat.nextTk = compteur;
        nouvelEtat.attenteSeq = Math.max(Number(state.attenteSeq) || 1, Number(nouvelEtat.attenteSeq) || 1);
        nouvelEtat.razLog = undefined; delete nouvelEtat.razLog;
        nouvelEtat.razCles = state.razCles || [];
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

    io.use((socket, next) => {
      const a = (socket.handshake && socket.handshake.address) || '';
      const local = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
      const t = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;
      const sess = t && sessions.get(String(t));
      socket.data.autorise = local || !!(sess && Date.now() <= sess.exp);
      next();
    });
    io.on('connection', (socket) => {
      try {
        if (!socket.data.autorise) return;
        socket.join('auth');
        socket.emit('state:changed', etatPublic(state));
      } catch (e) {
        console.error('[FSS-CAISSE] Erreur lors de la connexion d\'un poste :', e);
      }
    });

    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
};
