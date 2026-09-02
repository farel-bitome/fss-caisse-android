// FSS-CAISSE — Sauvegarde des informations de l'établissement
// (nom, téléphone, adresse, RCCM, NIF) — utilisées sur le reçu 80mm
window.saveEtabInfo = function () {
  window.etabInfo = {
    nom: (document.getElementById('etabNom') || {}).value || 'FSS-CAISSE',
    tel: (document.getElementById('etabTel') || {}).value || '',
    adr: (document.getElementById('etabAdr') || {}).value || '',
    rccm: (document.getElementById('etabRCCM') || {}).value || '',
    nif: (document.getElementById('etabNIF') || {}).value || '',
    msgFin: (document.getElementById('etabMsgFin') || {}).value || 'Merci pour votre visite !'
  };
  if (window.fssSyncPush) window.fssSyncPush();
  try { toast('Paramètres enregistrés', 's'); } catch (e) {}
};

// ---------- Logo de l'établissement (Paramètres > Établissement) ----------
function refreshEtabLogoPreview() {
  var img = document.getElementById('etabLogoPreview');
  var placeholder = document.getElementById('etabLogoPlaceholder');
  if (!img) return;
  if (window.logoData) {
    img.src = window.logoData;
    img.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
  } else {
    img.style.display = 'none';
    if (placeholder) placeholder.style.display = 'block';
  }
}
window.refreshEtabLogoPreview = refreshEtabLogoPreview;

window.removeEtabLogo = function () {
  window.logoData = null;
  refreshEtabLogoPreview();
  if (window.fssSyncPush) window.fssSyncPush();
  try { toast('Logo retiré', 'i'); } catch (e) {}
};

document.addEventListener('DOMContentLoaded', function () {
  var input = document.getElementById('etabLogoInput');
  if (!input) return;
  input.addEventListener('change', function () {
    var file = input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      window.logoData = e.target.result;
      refreshEtabLogoPreview();
      if (window.fssSyncPush) window.fssSyncPush();
      try { toast('Logo mis à jour', 's'); } catch (err) {}
    };
    reader.readAsDataURL(file);
  });
  refreshEtabLogoPreview();
});

document.addEventListener('fss:ready', refreshEtabLogoPreview);

