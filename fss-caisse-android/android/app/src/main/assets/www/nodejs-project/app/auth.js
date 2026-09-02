// FSS-CAISSE — Authentification (connexion, comptes, permissions, logo)
(function () {
  var dataReady = false;
  var currentUser = null;

  var MODULES = [
    { key: 'caisse', label: '🧾 Caisse (vente)' },
    { key: 'articles', label: '🍽️ Articles' },
    { key: 'stock', label: '📦 Stock' },
    { key: 'achats', label: '🛒 Achats' },
    { key: 'clients', label: '👥 Clients' },
    { key: 'fournisseurs', label: '🚚 Fournisseurs' },
    { key: 'bons', label: '📄 Bons & Ventes' },
    { key: 'rapports', label: '📊 Rapports' },
    { key: 'cloture', label: '🔒 Clôture' },
    { key: 'params', label: '⚙️ Paramètres' },
    { key: 'reimpression', label: '🖨️ Réimpression tickets' },
    { key: 'annulation', label: '🗑️ Annulation tickets' },
    { key: 'retraitArticle', label: '➖ Retirer article (factures / commandes en attente)' },
    { key: 'suppressionAttente', label: '🗑️ Supprimer une commande en attente' }
  ];

  document.addEventListener('fss:ready', function () {
    dataReady = true;
    var wait = document.getElementById('authWait');
    if (wait) wait.style.display = 'none';
  });

  function injectCSS() {
    var s = document.createElement('style');
    s.textContent =
      '#authOverlay,#userMgmtOverlay,#chgPwdOverlay,#permsOverlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;background:#0e0e0e;}' +
      '#authOverlay{overflow:hidden;}' +
      '#authWatermark{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.08;pointer-events:none;z-index:0;}' +
      '#authOverlay .box{position:relative;z-index:1;}' +
      '#userMgmtOverlay,#chgPwdOverlay,#permsOverlay{background:rgba(0,0,0,.75);display:none;}' +
      '#authOverlay .box,#chgPwdOverlay .box{background:#1c1c1c;padding:36px 40px;border-radius:12px;width:360px;text-align:center;border:1px solid #2a2a2a;}' +
      '#userMgmtOverlay .box,#permsOverlay .box{background:#1c1c1c;padding:24px 28px;border-radius:12px;width:460px;max-height:82vh;overflow:auto;border:1px solid #2a2a2a;}' +
      '#authOverlay h1,#userMgmtOverlay h2,#chgPwdOverlay h1,#permsOverlay h2{color:#CC0000;margin:0 0 6px;}' +
      '#authOverlay h1{font-size:20px;} #chgPwdOverlay h1{font-size:20px;} #userMgmtOverlay h2,#permsOverlay h2{font-size:16px;}' +
      '#authOverlay p,#chgPwdOverlay p,#permsOverlay p{color:#999;font-size:12px;margin:0 0 20px;}' +
      '#authOverlay input:not([type="checkbox"]),#userMgmtOverlay input:not([type="checkbox"]),#chgPwdOverlay input:not([type="checkbox"]){width:100%;padding:11px;margin-bottom:12px;border-radius:6px;border:1px solid #333;background:#0e0e0e;color:#fff;font-size:14px;box-sizing:border-box;}' +
      '#authOverlay button.main,#chgPwdOverlay button.main,#userMgmtOverlay button.main,#permsOverlay button.main{width:100%;padding:12px;border:none;border-radius:6px;background:#CC0000;color:#fff;font-weight:bold;cursor:pointer;font-size:14px;}' +
      '#authOverlay button.main:disabled{opacity:.5;cursor:default;}' +
      '#authOverlay button.main:hover,#chgPwdOverlay button.main:hover,#userMgmtOverlay button.main:hover,#permsOverlay button.main:hover{background:#a80000;}' +
      '.authErr{color:#FF4444;font-size:12px;margin-top:10px;min-height:16px;}' +
      '#authLogoImg{max-width:260px;max-height:160px;object-fit:contain;margin-bottom:16px;}' +
      '#userBadge{position:fixed;top:10px;right:14px;z-index:9999;background:#1c1c1c;border:1px solid #333;border-radius:20px;padding:7px 16px;font-size:12px;color:#fff;cursor:pointer;font-family:Arial,sans-serif;user-select:none;}' +
      '#userMenu{position:fixed;top:46px;right:14px;z-index:9999;background:#1c1c1c;border:1px solid #333;border-radius:8px;padding:6px;display:none;min-width:200px;font-family:Arial,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.4);}' +
      '#userMenu .mi{padding:9px 12px;font-size:12px;color:#eee;cursor:pointer;border-radius:5px;}' +
      '#userMenu .mi:hover{background:#2a2a2a;}' +
      '#userMgmtOverlay table{width:100%;border-collapse:collapse;margin-bottom:16px;}' +
      '#userMgmtOverlay td,#userMgmtOverlay th{padding:7px 4px;font-size:12px;border-bottom:1px solid #2a2a2a;color:#eee;text-align:left;}' +
      '#userMgmtOverlay button.sm,#permsOverlay button.sm{background:#333;border:none;color:#fff;border-radius:4px;padding:5px 9px;cursor:pointer;font-size:11px;margin-right:4px;}' +
      '#userMgmtOverlay button.sm:hover{background:#444;}' +
      '#userMgmtOverlay button.close,#permsOverlay button.close{background:transparent;border:1px solid #333;color:#999;width:100%;padding:9px;border-radius:6px;cursor:pointer;margin-top:6px;}' +
      '#userMgmtOverlay .badge-super{background:#CC0000;color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;margin-left:4px;}' +
      '#userMgmtOverlay .badge-full{background:#1144CC;color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;margin-left:4px;}' +
      '.permsGrid{text-align:left;display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;margin-bottom:14px;}' +
      '.permsGrid label{font-size:12px;color:#eee;cursor:pointer;line-height:1.4;position:relative;padding-left:22px;display:block;}' +
      '.permsGrid label input[type="checkbox"]{position:absolute;opacity:0;width:18px;height:18px;left:0;top:1px;margin:0;cursor:pointer;}' +
      '.permsGrid label .chkbx{position:absolute;left:0;top:1px;width:15px;height:15px;border:1.5px solid #666;border-radius:3px;background:#0e0e0e;box-sizing:border-box;}' +
      '.permsGrid label input[type="checkbox"]:checked ~ .chkbx{background:#CC0000;border-color:#CC0000;}' +
      '.permsGrid label input[type="checkbox"]:checked ~ .chkbx::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);}' +
      '#logoFileInput{display:none;}';
    document.head.appendChild(s);
  }

  // ---------- Écran de connexion ----------
  function buildLoginOverlay() {
    var ov = document.createElement('div');
    ov.id = 'authOverlay';
    var watermarkHtml = window.FSS_LOGIN_WATERMARK
      ? '<img id="authWatermark" src="' + window.FSS_LOGIN_WATERMARK + '">'
      : '';
    ov.innerHTML =
      watermarkHtml +
      '<div class="box">' +
      '<img id="authLogoImg" style="display:none">' +
      '<h1 id="authTitle">FSS-CAISSE</h1>' +
      '<p id="authWait">Connexion au serveur...</p>' +
      '<input id="authNom" placeholder="Identifiant" autocomplete="username">' +
      '<input id="authMdp" type="password" placeholder="Mot de passe" autocomplete="current-password">' +
      '<button class="main" id="authLoginBtn">Se connecter</button>' +
      '<div class="authErr" id="authErr"></div>' +
      '<div style="margin-top:22px;font-size:10px;color:#555;font-weight:700">D\u00e9velopp\u00e9 par FallServices&amp;Solutions \u2014 +241 77 37 86 02</div>' +
      '<div style="margin-top:4px;font-size:9px;color:#444;font-weight:700">v' + (window.FSS_VERSION || '?') + '</div>' +
      '</div>';
    document.body.appendChild(ov);

    document.getElementById('authLoginBtn').addEventListener('click', tryLogin);
    ov.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryLogin(); });
  }

  function updateLoginLogo() {
    var img = document.getElementById('authLogoImg');
    var title = document.getElementById('authTitle');
    if (!img) return;
    if (window.logoData) {
      img.src = window.logoData;
      img.style.display = 'block';
      if (title) title.style.display = 'none';
    } else {
      img.style.display = 'none';
      if (title) title.style.display = 'block';
    }
  }

  function tryLogin() {
    var nom = document.getElementById('authNom').value.trim();
    var mdp = document.getElementById('authMdp').value.trim();
    var err = document.getElementById('authErr');
    if (!dataReady || !(window.users || []).length) {
      err.textContent = 'Connexion en cours, réessayez dans un instant...';
      return;
    }
    var u = (window.users || []).find(function (x) {
      return x.nom.toLowerCase() === nom.toLowerCase() && x.mdp === mdp;
    });
    if (!u) { err.textContent = 'Identifiant ou mot de passe incorrect'; return; }
    err.textContent = '';
    currentUser = u;
    window.currentUser = u;
    document.getElementById('authOverlay').remove();
    if (u.doitChangerMdp) {
      showChangePassword(u, true);
    } else {
      enterApp();
    }
  }

  // ---------- Changement de mot de passe ----------
  function showChangePassword(u, forced) {
    if (u.super) { safeToast('Ce compte est protégé et ne peut jamais être modifié', 'e'); return; }
    var ov = document.createElement('div');
    ov.id = 'chgPwdOverlay';
    ov.style.display = 'flex';
    ov.innerHTML =
      '<div class="box">' +
      '<h1>🔑 Nouveau mot de passe</h1>' +
      '<p>' + (forced ? 'Première connexion — merci de définir un nouveau mot de passe pour "' + u.nom + '"' : 'Changer le mot de passe de "' + u.nom + '"') + '</p>' +
      '<input id="cpNew" type="password" placeholder="Nouveau mot de passe">' +
      '<input id="cpConfirm" type="password" placeholder="Confirmer le mot de passe">' +
      '<button class="main" id="cpBtn">Valider</button>' +
      '<div class="authErr" id="cpErr"></div>' +
      '</div>';
    document.body.appendChild(ov);

    document.getElementById('cpBtn').addEventListener('click', function () {
      var p1 = document.getElementById('cpNew').value;
      var p2 = document.getElementById('cpConfirm').value;
      var err = document.getElementById('cpErr');
      if (!p1 || p1.length < 3) { err.textContent = 'Mot de passe trop court (3 caractères minimum)'; return; }
      if (p1 !== p2) { err.textContent = 'Les mots de passe ne correspondent pas'; return; }
      u.mdp = p1;
      u.doitChangerMdp = false;
      if (window.fssSyncPush) window.fssSyncPush();
      ov.remove();
      if (forced) enterApp();
      else safeToast('Mot de passe modifié', 's');
    });
  }

  function safeToast(msg, typ) { try { toast(msg, typ); } catch (e) {} }

  // ---------- Droits d'accès ----------
  function hasAccess(u, moduleKey) {
    if (!u) return false;
    if (u.super || u.full) return true;
    if (u.waiterOnly) return moduleKey === 'caisse';
    return (u.perms || []).indexOf(moduleKey) !== -1;
  }

  window.hasReimprPermission = function () {
    return hasAccess(currentUser, 'reimpression');
  };

  // Permission distincte pour l'annulation de tickets (séparée de la réimpression).
  window.hasAnnulationPermission = function () {
    return hasAccess(currentUser, 'annulation');
  };

  window.hasRetraitArticlePermission = function () {
    return hasAccess(currentUser, 'retraitArticle');
  };

  window.isWaiterOnly = function () {
    return !!(currentUser && currentUser.waiterOnly);
  };

  window.waiterCanSeeAttente = function () {
    return !currentUser || !currentUser.waiterOnly || !!currentUser.waiterCanSeeAttente;
  };

  window.waiterCanDeleteAttente = function () {
    return !currentUser || !currentUser.waiterOnly || !!currentUser.waiterCanDeleteAttente;
  };

  // Permission de suppression d'une commande en attente — applicable à TOUS
  // les types de comptes (caissier, admin...), pas seulement les comptes
  // "serveur" (qui ont leur propre case dédiée "Peut supprimer les commandes
  // en attente" lors de leur création, gérée séparément par
  // waiterCanDeleteAttente ci-dessus).
  window.hasSuppressionAttentePermission = function () {
    if (!currentUser) return false;
    if (currentUser.waiterOnly) return window.waiterCanDeleteAttente();
    return hasAccess(currentUser, 'suppressionAttente');
  };

  function applyPermissions() {
    document.querySelectorAll('.nb').forEach(function (btn) {
      var m = (btn.getAttribute('onclick') || '').match(/goPage\('([a-zA-Z]+)'/);
      if (!m) return;
      btn.style.display = hasAccess(currentUser, m[1]) ? '' : 'none';
    });
    if (!window._goPageWrapped && typeof window.goPage === 'function') {
      var origGoPage = window.goPage;
      window.goPage = function (name, btn) {
        if (!hasAccess(currentUser, name)) {
          safeToast('Accès non autorisé pour ce compte', 'e');
          return;
        }
        return origGoPage(name, btn);
      };
      window._goPageWrapped = true;
    }
  }

  // ---------- Badge utilisateur + menu ----------
  function buildUserBadge() {
    var badge = document.createElement('div');
    badge.id = 'userBadge';
    badge.textContent = '👤 ' + currentUser.nom + (currentUser.super ? ' ⭐' : '');
    document.body.appendChild(badge);

    var canManage = currentUser.super || currentUser.full;

    var menu = document.createElement('div');
    menu.id = 'userMenu';
    menu.innerHTML =
      (!currentUser.super ? '<div class="mi" id="miChangePwd">🔑 Changer mon mot de passe</div>' : '') +
      (canManage ? '<div class="mi" id="miManageUsers">👥 Gérer les utilisateurs</div>' : '') +
      (canManage ? '<div class="mi" id="miChangeLogo">🖼️ Changer le logo</div>' : '') +
      '<div class="mi" id="miLogout">🚪 Déconnexion</div>';
    document.body.appendChild(menu);

    badge.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
    });
    document.addEventListener('click', function () { menu.style.display = 'none'; });

    if (!currentUser.super) {
      document.getElementById('miChangePwd').addEventListener('click', function () {
        menu.style.display = 'none';
        showChangePassword(currentUser, false);
      });
    }
    if (canManage) {
      document.getElementById('miManageUsers').addEventListener('click', function () {
        menu.style.display = 'none';
        openUserMgmt();
      });
      document.getElementById('miChangeLogo').addEventListener('click', function () {
        menu.style.display = 'none';
        document.getElementById('logoFileInput').click();
      });
    }
    document.getElementById('miLogout').addEventListener('click', function () {
      menu.style.display = 'none';
      var recharger = function () { location.reload(); };
      // Important : si une commande était en cours de reprise/édition (donc
      // temporairement retirée du serveur) au moment de la déconnexion, on la
      // remet en attente automatiquement avant de partir — via sa route
      // dédiée et protégée (qui ne touche à rien d'autre), et on attend
      // qu'elle soit vraiment partie avant de recharger.
      //
      // Important aussi : on ne force PLUS l'envoi de l'ÉTAT COMPLET avant de
      // se déconnecter, contrairement à avant. Ça semblait prudent au premier
      // abord, mais c'était en réalité risqué : si ce poste avait une vue un
      // peu en retard des données (ex: un téléphone resté un moment en
      // arrière-plan, où les mises à jour des autres postes peuvent être
      // retardées), renvoyer son état complet pouvait écraser des
      // changements plus récents faits ailleurs pendant ce temps — donnant
      // l'impression que les données "revenaient en arrière" après un
      // changement de compte. Tout ce qui doit vraiment être sauvegardé
      // utilise déjà sa propre route protégée à chaque modification.
      if (window.resumingAttenteId && window.tkt && window.tkt.length && typeof window.clearTk === 'function') {
        window.clearTk();
        if (window.fssDerniereEnvoyerCmdAttentePromise && typeof window.fssDerniereEnvoyerCmdAttentePromise.then === 'function') {
          window.fssDerniereEnvoyerCmdAttentePromise.then(recharger).catch(recharger);
          setTimeout(recharger, 3000); // filet de sécurité si ça traîne
          return;
        }
        setTimeout(recharger, 400);
        return;
      }
      recharger();
    });

    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'logoFileInput';
    fileInput.accept = 'image/*';
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', function () {
      var file = fileInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (e) {
        logoData = e.target.result;
        window.logoData = logoData;
        if (window.fssSyncPush) window.fssSyncPush();
        safeToast('Logo mis à jour', 's');
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------- Gestion des utilisateurs ----------
  function buildUserMgmtOverlay() {
    var ov = document.createElement('div');
    ov.id = 'userMgmtOverlay';
    var permsHtml = '<div class="permsGrid" id="umgtPermsGrid">' +
      MODULES.map(function (m) {
        return '<label><input type="checkbox" class="umgtPermChk" value="' + m.key + '"><span class="chkbx"></span>' + m.label + '</label>';
      }).join('') + '</div>';
    ov.innerHTML =
      '<div class="box">' +
      '<h2>👥 Gestion des utilisateurs</h2>' +
      '<table><thead><tr><th>Identifiant</th><th></th><th></th></tr></thead><tbody id="umgtBody"></tbody></table>' +
      '<div style="border-top:1px solid #2a2a2a;padding-top:14px;margin-top:4px">' +
      '<div style="font-size:12px;color:#ccc;margin-bottom:8px">➕ Nouvel utilisateur</div>' +
      '<input id="umgtNom" placeholder="Identifiant">' +
      '<input id="umgtMdp" type="password" placeholder="Mot de passe">' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#eee;margin:10px 0;padding:8px;background:#0e0e0e;border-radius:6px;border:1px solid #333;cursor:pointer">' +
      '<input type="checkbox" id="umgtWaiterChk" style="width:14px;height:14px;min-width:14px;padding:0;margin:0 6px 0 0;flex:none"> 🙋 Compte Serveur/Serveuse — prise de commande uniquement (pas d\'accès à l\'encaissement)' +
      '</label>' +
      '<div id="umgtWaiterOpts" style="display:none;margin:0 0 10px 8px">' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#ccc;margin-bottom:6px;cursor:pointer">' +
      '<input type="checkbox" id="umgtWaiterSeeChk" style="width:14px;height:14px;min-width:14px;padding:0;margin:0 6px 0 0;flex:none"> Peut voir les commandes en attente' +
      '</label>' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#ccc;cursor:pointer">' +
      '<input type="checkbox" id="umgtWaiterDelChk" style="width:14px;height:14px;min-width:14px;padding:0;margin:0 6px 0 0;flex:none"> Peut supprimer les commandes en attente' +
      '</label>' +
      '</div>' +
      '<div class="fg" style="margin:10px 0"><label class="fl" style="font-size:11px;color:#888;display:block;margin-bottom:6px">Rôle</label><select id="umgtRoleSel" style="width:100%;padding:9px;border-radius:6px;border:1px solid #333;background:#0e0e0e;color:#fff;font-size:13px"><option value="">— Non défini —</option><option value="Administrateur">Administrateur</option><option value="Gérant">Gérant</option><option value="Manager">Manager</option><option value="Caissier/Caissière">Caissier / Caissière</option><option value="Comptable">Comptable</option></select></div>' +
      '<div class="fg" style="margin:10px 0"><label class="fl" id="umgtCaisseLbl" style="font-size:11px;color:#888;display:block;margin-bottom:6px">Caisse assignée (optionnel)</label><select id="umgtCaisseSel" style="width:100%;padding:9px;border-radius:6px;border:1px solid #333;background:#0e0e0e;color:#fff;font-size:13px"><option value="">— Aucune (libre) —</option></select></div>' +
      '<div style="font-size:11px;color:#888;margin-bottom:6px" id="umgtPermsLabel">Accès autorisés :</div>' +
      permsHtml +
      '<button class="main" id="umgtAddBtn">➕ Ajouter l\'utilisateur</button>' +
      '<div class="authErr" id="umgtErr"></div>' +
      '</div>' +
      '<button class="close" id="umgtCloseBtn">Fermer</button>' +
      '</div>';
    document.body.appendChild(ov);

    document.getElementById('umgtAddBtn').addEventListener('click', addUser);
    document.getElementById('umgtCloseBtn').addEventListener('click', function () {
      ov.style.display = 'none';
    });
    document.getElementById('umgtWaiterChk').addEventListener('change', function (e) {
      var isWaiter = e.target.checked;
      document.getElementById('umgtPermsGrid').style.display = isWaiter ? 'none' : '';
      document.getElementById('umgtPermsLabel').style.display = isWaiter ? 'none' : '';
      document.getElementById('umgtWaiterOpts').style.display = isWaiter ? '' : 'none';
    });
    document.getElementById('umgtRoleSel').addEventListener('change', function (e) {
      var lbl = document.getElementById('umgtCaisseLbl');
      if (e.target.value === 'Caissier/Caissière') {
        lbl.innerHTML = 'Caisse assignée <span style="color:#FF4444">* obligatoire</span>';
      } else {
        lbl.textContent = 'Caisse assignée (optionnel)';
      }
    });
  }

  function renderUserMgmt() {
    var body = document.getElementById('umgtBody');
    if (!body) return;
    body.innerHTML = '';
    (window.users || []).forEach(function (u) {
      var tr = document.createElement('tr');
      var canDelete = !u.super;
      var tag = u.super ? '<span class="badge-super">SUPER</span>' : (u.full ? '<span class="badge-full">COMPLET</span>' : (u.waiterOnly ? '<span class="badge-full" style="background:#996600">SERVEUR</span>' : ''));
      var permsBtn = (!u.super && !u.full && !u.waiterOnly) ? '<button class="sm" data-action="perms" data-id="' + u.id + '">🛡️ Droits</button>' : '';
      var resetBtn = !u.super ? '<button class="sm" data-action="reset" data-id="' + u.id + '">🔑</button>' : '<span style="color:#555;font-size:11px">Protégé</span>';
      var roleTag = u.role ? '<div style="font-size:10px;color:#888;margin-top:2px">' + u.role + '</div>' : '';
      tr.innerHTML =
        '<td>' + u.nom + tag + roleTag + '</td>' +
        '<td>' + permsBtn + resetBtn + '</td>' +
        '<td>' + (canDelete ? '<button class="sm" data-action="del" data-id="' + u.id + '">🗑️</button>' : '') + '</td>';
      body.appendChild(tr);
    });
    body.querySelectorAll('button[data-action="del"]').forEach(function (b) {
      b.addEventListener('click', function () { deleteUser(parseInt(b.dataset.id, 10)); });
    });
    body.querySelectorAll('button[data-action="reset"]').forEach(function (b) {
      b.addEventListener('click', function () { resetUserPassword(parseInt(b.dataset.id, 10)); });
    });
    body.querySelectorAll('button[data-action="perms"]').forEach(function (b) {
      b.addEventListener('click', function () { openPermsEditor(parseInt(b.dataset.id, 10)); });
    });
  }

  function openUserMgmt() {
    try {
      openUserMgmtInterne();
    } catch (e) {
      console.error('Erreur openUserMgmt:', e);
      safeToast('Erreur à l\'ouverture : ' + e.message, 'e');
    }
  }
  function openUserMgmtInterne() {
    renderUserMgmt();
    document.getElementById('userMgmtOverlay').style.display = 'flex';
    document.getElementById('umgtErr').textContent = '';
    document.getElementById('umgtNom').value = '';
    document.getElementById('umgtMdp').value = '';
    var cxSel = document.getElementById('umgtCaisseSel');
    if (cxSel) {
      cxSel.innerHTML = '<option value="">— Aucune (libre) —</option>';
      (window.caisses || []).forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c; opt.text = c;
        cxSel.appendChild(opt);
      });
    }
    document.querySelectorAll('.umgtPermChk').forEach(function (c) { c.checked = false; });
  }

  function addUser() {
    try {
      addUserInterne();
    } catch (e) {
      console.error('Erreur addUser:', e);
      safeToast('Erreur : ' + e.message, 'e');
      var err = document.getElementById('umgtErr');
      if (err) err.textContent = 'Erreur technique : ' + e.message;
    }
  }
  function addUserInterne() {
    var nom = document.getElementById('umgtNom').value.trim();
    var mdp = document.getElementById('umgtMdp').value;
    var err = document.getElementById('umgtErr');
    if (!nom || !mdp) { err.textContent = 'Identifiant et mot de passe requis'; return; }
    var exists = (window.users || []).some(function (u) { return u.nom.toLowerCase() === nom.toLowerCase(); });
    if (exists) { err.textContent = 'Cet identifiant existe déjà'; return; }
    var isWaiter = document.getElementById('umgtWaiterChk').checked;
    var perms = [];
    if (!isWaiter) {
      document.querySelectorAll('.umgtPermChk').forEach(function (c) { if (c.checked) perms.push(c.value); });
    }
    var waiterCanSee = isWaiter && document.getElementById('umgtWaiterSeeChk').checked;
    var waiterCanDel = isWaiter && document.getElementById('umgtWaiterDelChk').checked;
    var caisseAssignee = (document.getElementById('umgtCaisseSel') || {}).value || '';
    var role = (document.getElementById('umgtRoleSel') || {}).value || '';
    if (!isWaiter && role === 'Caissier/Caissière' && !caisseAssignee) {
      err.textContent = 'Un compte Caissier/Caissière doit obligatoirement avoir une caisse assignée';
      return;
    }
    users.push({
      id: nextUserId, nom: nom, mdp: mdp, super: false, full: false,
      waiterOnly: isWaiter, waiterCanSeeAttente: waiterCanSee, waiterCanDeleteAttente: waiterCanDel,
      caisseAssignee: caisseAssignee, role: role,
      perms: perms, doitChangerMdp: false
    });
    nextUserId++;
    err.textContent = '';
    document.getElementById('umgtNom').value = '';
    document.getElementById('umgtMdp').value = '';
    document.getElementById('umgtWaiterChk').checked = false;
    document.getElementById('umgtWaiterSeeChk').checked = false;
    document.getElementById('umgtWaiterDelChk').checked = false;
    document.getElementById('umgtWaiterOpts').style.display = 'none';
    if (document.getElementById('umgtCaisseSel')) document.getElementById('umgtCaisseSel').value = '';
    if (document.getElementById('umgtRoleSel')) document.getElementById('umgtRoleSel').value = '';
    if (document.getElementById('umgtCaisseLbl')) document.getElementById('umgtCaisseLbl').textContent = 'Caisse assignée (optionnel)';
    document.getElementById('umgtPermsGrid').style.display = '';
    document.getElementById('umgtPermsLabel').style.display = '';
    document.querySelectorAll('.umgtPermChk').forEach(function (c) { c.checked = false; });
    if (window.fssSyncPush) window.fssSyncPush();
    renderUserMgmt();
    if (window.renderServerSelect) window.renderServerSelect();
    safeToast('Utilisateur ajouté', 's');
  }

  function deleteUser(id) {
    var u = (window.users || []).find(function (x) { return x.id === id; });
    if (!u) return;
    if (u.super) { safeToast('Ce compte ne peut pas être supprimé', 'e'); return; }
    if (!confirm('Supprimer l\'utilisateur "' + u.nom + '" ?')) return;
    users = users.filter(function (x) { return x.id !== id; });
    window.users = users;
    if (window.fssSyncPush) window.fssSyncPush();
    renderUserMgmt();
    if (window.renderServerSelect) window.renderServerSelect();
    safeToast('Utilisateur supprimé', 'i');
  }

  function resetUserPassword(id) {
    var u = (window.users || []).find(function (x) { return x.id === id; });
    if (!u) return;
    if (u.super) { safeToast('Ce compte est protégé et ne peut pas être modifié', 'e'); return; }
    showChangePassword(u, false);
  }

  // ---------- Édition des droits d'un utilisateur existant ----------
  function buildPermsOverlay() {
    var ov = document.createElement('div');
    ov.id = 'permsOverlay';
    var permsHtml = '<div class="permsGrid" id="permsGrid">' +
      MODULES.map(function (m) {
        return '<label><input type="checkbox" class="permsChk" value="' + m.key + '"><span class="chkbx"></span>' + m.label + '</label>';
      }).join('') + '</div>';
    ov.innerHTML =
      '<div class="box">' +
      '<h2>🛡️ Droits d\'accès — <span id="permsUserName"></span></h2>' +
      '<p>Coche les sections que ce compte pourra voir.</p>' +
      permsHtml +
      '<button class="main" id="permsSaveBtn">Enregistrer</button>' +
      '<button class="close" id="permsCloseBtn">Annuler</button>' +
      '</div>';
    document.body.appendChild(ov);
    document.getElementById('permsCloseBtn').addEventListener('click', function () {
      ov.style.display = 'none';
      var mgmt = document.getElementById('userMgmtOverlay');
      if (mgmt) mgmt.style.display = 'flex';
    });
  }

  var editingUserId = null;
  function openPermsEditor(id) {
    var u = (window.users || []).find(function (x) { return x.id === id; });
    if (!u) return;
    if (u.super || u.full) { safeToast('Ce compte a déjà accès à tout et ne peut pas être modifié', 'e'); return; }
    editingUserId = id;
    u.perms = u.perms || [];
    document.getElementById('permsUserName').textContent = u.nom;
    document.querySelectorAll('.permsChk').forEach(function (c) {
      c.checked = (u.perms || []).indexOf(c.value) !== -1;
    });
    document.getElementById('permsOverlay').style.display = 'flex';
    var mgmt = document.getElementById('userMgmtOverlay');
    if (mgmt) mgmt.style.display = 'none';
  }

  function bindPermsSaveBtn() {
    var saveBtn = document.getElementById('permsSaveBtn');
    if (saveBtn && !saveBtn._bound) {
      saveBtn._bound = true;
      saveBtn.addEventListener('click', function () {
        var u = (window.users || []).find(function (x) { return x.id === editingUserId; });
        if (!u) return;
        var perms = [];
        document.querySelectorAll('.permsChk').forEach(function (c) { if (c.checked) perms.push(c.value); });
        u.perms = perms;
        if (window.fssSyncPush) window.fssSyncPush();
        document.getElementById('permsOverlay').style.display = 'none';
        var mgmt = document.getElementById('userMgmtOverlay');
        if (mgmt) mgmt.style.display = 'flex';
        safeToast('Droits mis à jour', 's');
      });
    }
  }

  // ---------- Entrée dans l'application ----------
  function enterApp() {
    buildUserBadge();
    buildUserMgmtOverlay();
    buildPermsOverlay();
    bindPermsSaveBtn();
    applyPermissions();
    try { renderRap(); } catch (e) {}
    try { renderTkList(); } catch (e) {}
    try { if (window.applyWaiterUI) window.applyWaiterUI(); } catch (e) {}
    try { if (window.applyPerfSectionVisibility) window.applyPerfSectionVisibility(); } catch (e) {}
  }

  injectCSS();
  buildLoginOverlay();
})();
