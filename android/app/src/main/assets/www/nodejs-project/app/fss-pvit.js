/*!
 * FSS-PVIT — Paiement Mobile Money (Airtel Money / Moov Money) via le relais FSS-PAY
 * FALLSERVICES&SOLUTIONS INFO — Farel Bitome
 *
 * Fonctionne dans : navigateur, Electron (FSS-CAISSE PC), Capacitor (FSS-CAISSE TPE), Node 18+.
 *
 * Utilisation minimale :
 *   <script src="fss-pvit.js"></script>
 *   FssPvit.configurer({ relais: 'https://pay.mondomaine.com', cle: 'CLE_DU_TERMINAL' });
 *   const r = await FssPvit.payer({ montant: 12500, ticket: 'T-0042', libelle: 'Table 5', caissier: 'Marie' });
 *   if (r.paye) { ... valider la vente, imprimer FssPvit.lignesTicket(r.paiement) ... }
 */
(function (racine, fabrique) {
  const lib = fabrique(racine);
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (racine) racine.FssPvit = lib;
})(typeof window !== 'undefined' ? window : null, function (win) {
  'use strict';

  const CLE_STOCKAGE = 'fss-pvit-config';
  // proxy : chemin d'un relais local (ex. '/api/pvit/proxy' sur le serveur FSS-CAISSE) qui détient
  // lui-même la clé du terminal. Dans ce mode, aucune clé n'est présente dans le navigateur.
  const cfg = { relais: '', cle: '', proxy: '', caissier: '', delaiMaxS: 180 };

  // ---------------------------------------------------------------- config
  function lireStockage() {
    try {
      const s = win && win.localStorage && win.localStorage.getItem(CLE_STOCKAGE);
      if (s) Object.assign(cfg, JSON.parse(s));
    } catch (e) { /* stockage indisponible */ }
  }
  function ecrireStockage() {
    try {
      if (win && win.localStorage) win.localStorage.setItem(CLE_STOCKAGE, JSON.stringify({ relais: cfg.relais, cle: cfg.cle, caissier: cfg.caissier }));
    } catch (e) { /* */ }
  }
  lireStockage();

  function configurer(options, { memoriser = true } = {}) {
    Object.assign(cfg, options || {});
    cfg.relais = String(cfg.relais || '').replace(/\/+$/, '');
    if (memoriser) ecrireStockage();
    return Object.assign({}, cfg, { cle: cfg.cle ? '••••' + String(cfg.cle).slice(-4) : '' });
  }
  const estConfigure = () => Boolean(cfg.proxy || (cfg.relais && cfg.cle));
  const adresseApi = (chemin) => (cfg.proxy ? cfg.proxy.replace(/\/+$/, '') : cfg.relais + '/api') + chemin;

  // ------------------------------------------------------------------- API
  async function requete(methode, chemin, corps) {
    if (!estConfigure()) throw new Error('Paiement Mobile Money non configuré (adresse du relais et clé du terminal).');
    let rep;
    try {
      const entetes = { 'Content-Type': 'application/json' };
      if (!cfg.proxy) entetes['X-FSS-Cle'] = cfg.cle;
      rep = await fetch(adresseApi(chemin), {
        method: methode,
        headers: entetes,
        body: corps ? JSON.stringify(corps) : undefined,
      });
    } catch (e) {
      const err = new Error('Pas de connexion Internet ou relais FSS-PAY injoignable.');
      err.reseau = true;
      throw err;
    }
    let json = {};
    try { json = await rep.json(); } catch (e) { /* */ }
    if (!rep.ok && !json.paiement) {
      const err = new Error(json.erreur || ('Erreur ' + rep.status));
      err.http = rep.status; err.code = json.code;
      throw err;
    }
    return json;
  }

  const api = {
    sante: () => fetch(adresseApi('/sante')).then((r) => r.json()),
    kyc: (telephone, operateur) => requete('GET', '/kyc?telephone=' + encodeURIComponent(telephone) + (operateur ? '&operateur=' + operateur : '')),
    frais: (montant, operateur) => requete('GET', '/frais?montant=' + montant + '&operateur=' + operateur),
    initier: (p) => requete('POST', '/paiements', p),
    suivre: (reference, verifier) => requete('GET', '/paiements/' + encodeURIComponent(reference) + (verifier ? '?verifier=1' : '')),
    historique: (du, au, tous) => requete('GET', '/paiements?du=' + (du || '') + '&au=' + (au || du || '') + (tous ? '&tous=1' : '')),
    solde: () => requete('GET', '/solde'),
  };

  // ------------------------------------------------------------ utilitaires
  function normaliserTelephone(brut) {
    let t = String(brut || '').replace(/[^\d+]/g, '').replace(/^\+/, '').replace(/^00/, '');
    if (t.startsWith('241') && (t.length === 12 || t.length === 11)) t = t.slice(3);
    if (t.length === 8 && /^[67]/.test(t)) t = '0' + t;
    return t;
  }
  function detecterOperateur(t) {
    if (/^07\d{7}$/.test(t)) return 'airtel';
    if (/^06\d{7}$/.test(t)) return 'moov';
    return null;
  }
  const fcfa = (n) => (n == null ? '' : Math.round(Number(n)).toLocaleString('fr-FR').replace(/ | /g, ' ') + ' FCFA');
  const telLisible = (t) => (t && t.length === 9 ? t.replace(/^(\d{3})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4') : t || '');
  const telMasque = (t) => (t && t.length === 9 ? t.slice(0, 3) + ' ** ** ' + t.slice(7) : t || '');
  const NOM_OP = { airtel: 'Airtel Money', moov: 'Moov Money', gimac: 'QR GIMAC' };
  const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Lignes à imprimer sur le ticket de caisse. */
  function lignesTicket(p) {
    if (!p) return [];
    return [
      'Paiement : ' + (NOM_OP[p.operateur] || p.operateur || 'Mobile Money'),
      'Téléphone : ' + telMasque(p.telephone),
      'Réf. PVIT : ' + (p.transactionId || '-'),
      'Réf. FSS : ' + p.reference,
    ];
  }

  function bip(ok) {
    try {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const notes = ok ? [880, 1320] : [300, 220];
      notes.forEach((f, i) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = f; o.type = 'sine';
        g.gain.setValueAtTime(0.18, ctx.currentTime + i * 0.16);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.16 + 0.15);
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.16); o.stop(ctx.currentTime + i * 0.16 + 0.16);
      });
      setTimeout(() => ctx.close(), 800);
    } catch (e) { /* */ }
  }

  // --------------------------------------------------------------- styles
  const CSS = `
.fsspv-voile *{box-sizing:border-box;font-family:inherit;letter-spacing:normal;text-transform:none;text-shadow:none}
.fsspv-voile button{margin:0;padding:0;width:auto;height:auto;min-width:0;min-height:0;box-shadow:none;line-height:1.2;font-family:inherit}
.fsspv-voile p,.fsspv-voile h2{margin:0;color:inherit;font-family:inherit}
.fsspv-voile input{margin:0;box-shadow:none;height:auto}
.fsspv-voile{position:fixed;inset:0;background:rgba(10,14,20,.62);display:flex;align-items:center;justify-content:center;z-index:2147483000;padding:12px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}
.fsspv-voile .fsspv-carte{background:#fff;color:#1b1f24;width:100%;max-width:420px;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.35);overflow:hidden;max-height:calc(100vh - 24px);display:flex;flex-direction:column}
.fsspv-voile .fsspv-tete{padding:16px 18px 12px;border-bottom:1px solid #eceff3;display:flex;justify-content:space-between;align-items:center;gap:8px}
.fsspv-voile .fsspv-titre{font-size:17px;font-weight:700;margin:0}
.fsspv-voile .fsspv-x{border:0;background:#f1f3f6;width:36px;height:36px;border-radius:50%;font-size:22px;line-height:36px;padding:0;text-align:center;cursor:pointer;color:#444;flex:none}
.fsspv-voile .fsspv-corps{padding:16px 18px 18px;overflow:auto}
.fsspv-voile .fsspv-montant{text-align:center;font-size:30px;font-weight:800;letter-spacing:.5px;margin:2px 0 4px}
.fsspv-voile .fsspv-sous{text-align:center;color:#687281;font-size:13px;margin-bottom:14px;min-height:16px}
.fsspv-voile .fsspv-lbl{display:block;font-size:13px;font-weight:600;color:#39414d;margin:0 0 6px}
.fsspv-voile .fsspv-tel{width:100%;box-sizing:border-box;font-size:24px;font-weight:700;letter-spacing:2px;text-align:center;padding:12px;border:2px solid #d5dae1;border-radius:12px;outline:none;color:#111}
.fsspv-voile .fsspv-tel:focus{border-color:#2b6cb0}
.fsspv-voile .fsspv-ops{display:flex;gap:10px;margin:12px 0 4px}
.fsspv-voile .fsspv-op{flex:1;border:2px solid #d5dae1;background:#fff;border-radius:12px;padding:11px 6px;font-size:15px;font-weight:700;cursor:pointer;color:#39414d}
.fsspv-voile .fsspv-op[data-op=airtel].actif{border-color:#e40000;background:#fff1f1;color:#c00000}
.fsspv-voile .fsspv-op[data-op=moov].actif{border-color:#0055a5;background:#eef5ff;color:#004a91}
.fsspv-voile .fsspv-info{font-size:14px;margin:10px 0 0;min-height:20px;text-align:center}
.fsspv-voile .fsspv-info.ok{color:#146c2e}.fsspv-voile .fsspv-info.err{color:#b42318}
.fsspv-voile .fsspv-frais{font-size:13px;color:#687281;text-align:center;margin-top:6px;min-height:16px}
.fsspv-voile .fsspv-btn{display:block;width:100%;border:0;border-radius:12px;padding:15px;font-size:16px;font-weight:700;cursor:pointer;margin-top:14px}
.fsspv-voile .fsspv-btn[disabled]{opacity:.45;cursor:not-allowed}
.fsspv-voile .fsspv-p{background:#1f7a3a;color:#fff}.fsspv-voile .fsspv-s{background:#eef1f5;color:#26303b}.fsspv-voile .fsspv-d{background:#fff;color:#b42318;border:1px solid #f1c3be}
.fsspv-voile .fsspv-etat{text-align:center;padding:6px 0 2px}
.fsspv-voile .fsspv-rond{width:74px;height:74px;border-radius:50%;margin:4px auto 12px;display:flex;align-items:center;justify-content:center;font-size:40px;font-weight:800;color:#fff}
.fsspv-voile .fsspv-rond.ok{background:#1f9d49}.fsspv-voile .fsspv-rond.ko{background:#d92d20}.fsspv-voile .fsspv-rond.doute{background:#f79009}
.fsspv-voile .fsspv-spin{width:64px;height:64px;margin:6px auto 14px;border-radius:50%;border:6px solid #e3e8ef;border-top-color:#1f7a3a;animation:fsspv-t 1s linear infinite}
@keyframes fsspv-t{to{transform:rotate(360deg)}}
.fsspv-voile .fsspv-grand{font-size:19px;font-weight:800;margin:0 0 6px;color:inherit}
.fsspv-voile .fsspv-txt{font-size:14px;color:#4b5563;margin:0 0 4px;line-height:1.45}
.fsspv-voile .fsspv-chrono{font-variant-numeric:tabular-nums;color:#687281;font-size:13px;margin-top:8px}
.fsspv-voile .fsspv-ref{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#687281;margin-top:8px;word-break:break-all}
.fsspv-voile .fsspv-champ{width:100%;box-sizing:border-box;font-size:15px;padding:11px;border:1.5px solid #d5dae1;border-radius:10px;margin-bottom:12px}
@media (prefers-color-scheme: dark){
 .fsspv-voile .fsspv-carte{background:#1b1f26;color:#e8ebef}.fsspv-voile .fsspv-tete{border-color:#2c323c}.fsspv-voile .fsspv-x{background:#2c323c;color:#ddd}
 .fsspv-voile .fsspv-lbl{color:#c5ccd6}.fsspv-voile .fsspv-tel,.fsspv-voile .fsspv-champ{background:#11151b;color:#fff;border-color:#3a414d}
 .fsspv-voile .fsspv-op{background:#11151b;border-color:#3a414d;color:#c5ccd6}
 .fsspv-voile .fsspv-op[data-op=airtel].actif{background:#3a1414;color:#ff8a8a}.fsspv-voile .fsspv-op[data-op=moov].actif{background:#0f2440;color:#8cc2ff}
 .fsspv-voile .fsspv-s{background:#2c323c;color:#e8ebef}.fsspv-voile .fsspv-d{background:transparent;color:#ff9b8f;border-color:#6b2b25}.fsspv-voile .fsspv-txt{color:#aeb6c2}.fsspv-voile .fsspv-spin{border-color:#2c323c;border-top-color:#39b061}
}`;
  function injecterCss() {
    if (!win || win.document.getElementById('fsspv-css')) return;
    const st = win.document.createElement('style');
    st.id = 'fsspv-css'; st.textContent = CSS;
    win.document.head.appendChild(st);
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // --------------------------------------------------------- fenêtre payer
  /**
   * Ouvre la fenêtre de paiement Mobile Money.
   * @returns Promise<{ paye:boolean, statut:string, paiement:object|null, annule?:boolean }>
   */
  function payer({ montant, ticket, libelle, caissier, telephone } = {}) {
    montant = Math.round(Number(montant));
    if (!win) return Promise.reject(new Error('payer() nécessite un navigateur : utilisez FssPvit.api.initier() côté serveur.'));
    if (!(montant > 0)) return Promise.reject(new Error('Montant invalide'));
    injecterCss();

    return new Promise((resoudre) => {
      const d = win.document;
      const voile = d.createElement('div');
      voile.className = 'fsspv-voile';
      voile.innerHTML = '<div class="fsspv-carte" role="dialog" aria-modal="true" aria-label="Paiement Mobile Money">' +
        '<div class="fsspv-tete"><h2 class="fsspv-titre">Paiement Mobile Money</h2><button class="fsspv-x" aria-label="Fermer">×</button></div>' +
        '<div class="fsspv-corps"></div></div>';
      d.body.appendChild(voile);
      const corps = voile.querySelector('.fsspv-corps');
      const btnX = voile.querySelector('.fsspv-x');

      let etat = 'saisie';
      let op = null;
      let paiement = null;
      let fini = false;
      let jetonKyc = 0;
      let arretSuivi = false;

      function terminer(resultat) {
        if (fini) return;
        fini = true; arretSuivi = true;
        d.removeEventListener('keydown', surTouche, true);
        voile.remove();
        resoudre(resultat);
      }
      function surTouche(e) {
        if (e.key === 'Escape' && etat === 'saisie') { e.preventDefault(); terminer({ paye: false, statut: 'ANNULE', paiement: null, annule: true }); }
      }
      d.addEventListener('keydown', surTouche, true);
      btnX.onclick = () => {
        if (etat === 'attente') return afficherQuitterAttente();
        terminer(resultatCourant());
      };
      const resultatCourant = () => paiement
        ? { paye: paiement.statut === 'SUCCESS', statut: paiement.statut, paiement }
        : { paye: false, statut: 'ANNULE', paiement: null, annule: true };

      // ---- Écran 1 : saisie du numéro
      function ecranSaisie(message) {
        etat = 'saisie';
        corps.innerHTML =
          '<div class="fsspv-montant">' + esc(fcfa(montant)) + '</div>' +
          '<div class="fsspv-sous">' + esc([libelle, ticket ? 'Ticket ' + ticket : ''].filter(Boolean).join(' · ')) + '</div>' +
          '<label class="fsspv-lbl" for="fsspv-tel">Numéro Mobile Money du client</label>' +
          '<input id="fsspv-tel" class="fsspv-tel" inputmode="numeric" autocomplete="off" maxlength="16" placeholder="074 00 00 00">' +
          '<div class="fsspv-ops"><button class="fsspv-op" data-op="airtel">Airtel Money</button><button class="fsspv-op" data-op="moov">Moov Money</button></div>' +
          '<div class="fsspv-info"></div><div class="fsspv-frais"></div>' +
          '<button class="fsspv-btn fsspv-p" disabled>Envoyer la demande au client</button>' +
          '<button class="fsspv-btn fsspv-s">Annuler</button>';
        const champ = corps.querySelector('.fsspv-tel');
        const info = corps.querySelector('.fsspv-info');
        const fraisEl = corps.querySelector('.fsspv-frais');
        const btnOk = corps.querySelector('.fsspv-p');
        const boutonsOp = corps.querySelectorAll('.fsspv-op');
        corps.querySelector('.fsspv-s').onclick = () => terminer({ paye: false, statut: 'ANNULE', paiement: null, annule: true });

        const majOp = () => boutonsOp.forEach((b) => b.classList.toggle('actif', b.dataset.op === op));
        boutonsOp.forEach((b) => { b.onclick = () => { op = b.dataset.op; majOp(); verifierSaisie(); }; });

        if (message) { info.className = 'fsspv-info err'; info.textContent = message; }
        if (telephone) champ.value = telLisible(normaliserTelephone(telephone));

        function verifierSaisie() {
          const t = normaliserTelephone(champ.value);
          const valide = /^0[67]\d{7}$/.test(t);
          if (valide && !op) { op = detecterOperateur(t); majOp(); }
          btnOk.disabled = !(valide && op);
          if (!valide) { info.className = 'fsspv-info'; info.textContent = t.length >= 9 ? 'Numéro invalide' : ''; fraisEl.textContent = ''; return; }
          const jeton = ++jetonKyc;
          info.className = 'fsspv-info'; info.textContent = 'Vérification du compte…';
          api.kyc(t, op).then((r) => {
            if (jeton !== jetonKyc) return;
            info.className = 'fsspv-info ok';
            info.textContent = r.nom ? 'Titulaire : ' + r.nom : NOM_OP[op] + ' ✓';
          }).catch((e) => {
            if (jeton !== jetonKyc) return;
            info.className = 'fsspv-info err'; info.textContent = e.message;
          });
          api.frais(montant, op).then((r) => {
            if (jeton !== jetonKyc || r.frais == null) return;
            fraisEl.textContent = r.payePar === 'MERCHANT'
              ? 'Frais PVIT à votre charge : ' + fcfa(r.frais)
              : 'Frais PVIT : ' + fcfa(r.frais) + ' — le client paiera ' + fcfa(r.total);
          }).catch(() => { /* frais indicatifs */ });
        }
        champ.addEventListener('input', () => {
          const t = normaliserTelephone(champ.value);
          const detecte = detecterOperateur(t);
          if (detecte) { op = detecte; majOp(); }
          verifierSaisie();
        });
        champ.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btnOk.disabled) btnOk.click(); });
        btnOk.onclick = () => envoyer(normaliserTelephone(champ.value));
        if (champ.value) verifierSaisie();
        setTimeout(() => champ.focus(), 50);
      }

      // ---- Envoi de la demande
      async function envoyer(tel) {
        etat = 'envoi';
        corps.innerHTML = '<div class="fsspv-etat"><div class="fsspv-spin"></div><p class="fsspv-grand">Envoi de la demande…</p></div>';
        try {
          const r = await api.initier({ montant, telephone: tel, operateur: op, ticket, libelle, caissier: caissier || cfg.caissier });
          paiement = r.paiement;
          if (paiement.statut === 'FAILED') return ecranResultat();
          suivre();
        } catch (e) {
          ecranSaisie(e.message);
        }
      }

      // ---- Écran 2 : attente de la validation par le client
      async function suivre() {
        etat = 'attente';
        const debut = Date.now();
        corps.innerHTML =
          '<div class="fsspv-etat"><div class="fsspv-spin"></div>' +
          '<p class="fsspv-grand">En attente du client</p>' +
          '<p class="fsspv-txt">Demande de <b>' + esc(fcfa(montant)) + '</b> envoyée au <b>' + esc(telLisible(paiement.telephone)) + '</b> (' + esc(NOM_OP[paiement.operateur] || '') + ').</p>' +
          '<p class="fsspv-txt">Le client doit valider sur son téléphone avec son <b>code PIN</b>.</p>' +
          '<div class="fsspv-chrono">0:00</div></div>' +
          '<button class="fsspv-btn fsspv-s fsspv-verif">Vérifier maintenant</button>';
        const chrono = corps.querySelector('.fsspv-chrono');
        let forcer = false;
        corps.querySelector('.fsspv-verif').onclick = () => { forcer = true; };
        arretSuivi = false;

        while (!arretSuivi) {
          const ecoule = (Date.now() - debut) / 1000;
          chrono.textContent = Math.floor(ecoule / 60) + ':' + String(Math.floor(ecoule % 60)).padStart(2, '0');
          try {
            const r = await api.suivre(paiement.reference, forcer || (ecoule > 60 && Math.floor(ecoule) % 15 < 3));
            forcer = false;
            paiement = r.paiement;
          } catch (e) { /* coupure réseau passagère : on continue */ }
          if (fini || arretSuivi) return;
          if (paiement.statut === 'SUCCESS' || paiement.statut === 'FAILED') return ecranResultat();
          if (ecoule > cfg.delaiMaxS) return ecranResultat();
          for (let i = 0; i < 6 && !forcer && !arretSuivi; i++) await attendre(500);
        }
      }

      function afficherQuitterAttente() {
        arretSuivi = true;
        etat = 'quitter';
        corps.innerHTML =
          '<div class="fsspv-etat"><div class="fsspv-rond doute">!</div>' +
          '<p class="fsspv-grand">Arrêter d’attendre ?</p>' +
          '<p class="fsspv-txt">Le client peut encore valider le paiement. Il apparaîtra alors dans l’historique Mobile Money.</p></div>' +
          '<button class="fsspv-btn fsspv-s fsspv-reprendre">Continuer d’attendre</button>' +
          '<button class="fsspv-btn fsspv-d fsspv-quitter">Fermer sans attendre</button>';
        corps.querySelector('.fsspv-reprendre').onclick = suivre;
        corps.querySelector('.fsspv-quitter').onclick = () => terminer(resultatCourant());
      }

      // ---- Écran 3 : résultat
      function ecranResultat() {
        etat = 'resultat';
        arretSuivi = true;
        const s = paiement.statut;
        let html;
        if (s === 'SUCCESS') {
          bip(true);
          html = '<div class="fsspv-etat"><div class="fsspv-rond ok">✓</div><p class="fsspv-grand">Paiement reçu</p>' +
            '<p class="fsspv-txt">' + esc(fcfa(paiement.montant)) + ' via ' + esc(NOM_OP[paiement.operateur] || '') + '</p>' +
            '<div class="fsspv-ref">Réf. PVIT ' + esc(paiement.transactionId || '') + '</div></div>' +
            '<button class="fsspv-btn fsspv-p fsspv-fin">Terminer</button>';
        } else if (s === 'FAILED') {
          bip(false);
          html = '<div class="fsspv-etat"><div class="fsspv-rond ko">✕</div><p class="fsspv-grand">Paiement non effectué</p>' +
            '<p class="fsspv-txt">' + esc(paiement.message || 'Refusé ou annulé par le client.') + '</p></div>' +
            '<button class="fsspv-btn fsspv-p fsspv-encore">Réessayer</button>' +
            '<button class="fsspv-btn fsspv-s fsspv-fin">Autre mode de paiement</button>';
        } else {
          html = '<div class="fsspv-etat"><div class="fsspv-rond doute">?</div><p class="fsspv-grand">Paiement non confirmé</p>' +
            '<p class="fsspv-txt">Aucune confirmation reçue pour l’instant. <b>Ne relancez pas un nouveau paiement</b> : vérifiez d’abord.</p>' +
            '<div class="fsspv-ref">Réf. ' + esc(paiement.reference) + '</div></div>' +
            '<button class="fsspv-btn fsspv-p fsspv-attendre">Vérifier / attendre encore</button>' +
            '<button class="fsspv-btn fsspv-s fsspv-fin">Fermer</button>';
        }
        corps.innerHTML = html;
        const fin = corps.querySelector('.fsspv-fin');
        if (fin) { fin.onclick = () => terminer(resultatCourant()); setTimeout(() => fin.focus(), 50); }
        const encore = corps.querySelector('.fsspv-encore');
        if (encore) encore.onclick = () => { telephone = paiement.telephone; paiement = null; ecranSaisie(); };
        const att = corps.querySelector('.fsspv-attendre');
        if (att) att.onclick = suivre;
      }

      if (!estConfigure()) {
        corps.innerHTML = '<div class="fsspv-etat"><div class="fsspv-rond doute">!</div><p class="fsspv-grand">Non configuré</p>' +
          '<p class="fsspv-txt">Renseignez l’adresse du relais FSS-PAY et la clé de ce terminal dans les paramètres.</p></div>' +
          '<button class="fsspv-btn fsspv-p fsspv-param">Ouvrir les paramètres</button>';
        corps.querySelector('.fsspv-param').onclick = async () => {
          terminer({ paye: false, statut: 'NON_CONFIGURE', paiement: null, annule: true });
          if (await ouvrirParametres()) payer({ montant, ticket, libelle, caissier, telephone });
        };
      } else {
        ecranSaisie();
      }
    });
  }

  // --------------------------------------------------- fenêtre paramètres
  function ouvrirParametres() {
    injecterCss();
    return new Promise((resoudre) => {
      const d = win.document;
      const voile = d.createElement('div');
      voile.className = 'fsspv-voile';
      voile.innerHTML = '<div class="fsspv-carte" role="dialog" aria-modal="true"><div class="fsspv-tete"><h2 class="fsspv-titre">Paramètres Mobile Money</h2><button class="fsspv-x">×</button></div>' +
        '<div class="fsspv-corps">' +
        '<label class="fsspv-lbl">Adresse du relais FSS-PAY</label><input class="fsspv-champ fsspv-r" placeholder="https://pay.mondomaine.com">' +
        '<label class="fsspv-lbl">Clé de ce terminal</label><input class="fsspv-champ fsspv-c" autocomplete="off">' +
        '<div class="fsspv-info"></div>' +
        '<button class="fsspv-btn fsspv-s fsspv-test">Tester la connexion</button>' +
        '<button class="fsspv-btn fsspv-p fsspv-ok">Enregistrer</button></div></div>';
      d.body.appendChild(voile);
      const r = voile.querySelector('.fsspv-r'); const c = voile.querySelector('.fsspv-c'); const info = voile.querySelector('.fsspv-info');
      r.value = cfg.relais; c.value = cfg.cle;
      const fermer = (ok) => { voile.remove(); resoudre(ok); };
      voile.querySelector('.fsspv-x').onclick = () => fermer(false);
      voile.querySelector('.fsspv-test').onclick = async () => {
        const ancien = { relais: cfg.relais, cle: cfg.cle };
        configurer({ relais: r.value.trim(), cle: c.value.trim() }, { memoriser: false });
        info.className = 'fsspv-info'; info.textContent = 'Test en cours…';
        try {
          const s = await api.sante();
          if (!s.pvitConfigure) throw new Error('Relais joignable mais PVIT non configuré sur le serveur');
          await api.historique();
          info.className = 'fsspv-info ok'; info.textContent = 'Connexion réussie ✓';
        } catch (e) {
          info.className = 'fsspv-info err'; info.textContent = e.message;
        } finally {
          configurer(ancien, { memoriser: false });
        }
      };
      voile.querySelector('.fsspv-ok').onclick = () => { configurer({ relais: r.value.trim(), cle: c.value.trim() }); fermer(true); };
    });
  }

  return {
    version: '1.0.0',
    configurer,
    estConfigure,
    payer,
    ouvrirParametres,
    lignesTicket,
    api,
    outils: { normaliserTelephone, detecterOperateur, fcfa, telLisible, telMasque },
  };
});
