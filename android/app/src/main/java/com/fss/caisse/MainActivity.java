package com.fss.caisse;

import android.Manifest;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final int REQUEST_NOTIFICATIONS = 4821;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Un TPE reste affiché en continu pendant le service — on évite que l'écran ne
        // s'éteigne tout seul pendant l'utilisation (l'appareil peut toujours être verrouillé
        // manuellement).
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Android 13+ (API 33) exige cette permission pour afficher la notification du
        // foreground service (voir FssServerService), sans quoi le service serait refusé.
        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
            }
        }

        WebView webView = this.bridge.getWebView();

        // Autorise le contenu HTTP en clair (serveur embarqué local + serveur PC en LAN, tous
        // deux en http:// simple — pas de certificat sur un réseau de restaurant/boutique).
        // Complète android:usesCleartextTraffic="true" du Manifest.
        WebSettings settings = webView.getSettings();
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setDomStorageEnabled(true);
        settings.setJavaScriptEnabled(true);

        // Pont natif <-> JS, disponible sur TOUTE page chargée dans cette WebView (bundle
        // Capacitor, serveur local 127.0.0.1, ou serveur PC distant en LAN) — voir
        // FssNativeBridge pour le détail de chaque méthode.
        webView.addJavascriptInterface(new FssNativeBridge(this, webView), "FssNativeBridge");

        // Remplace le WebViewClient par notre variante qui injecte android-bridge.js sur chaque
        // page (voir FssWebViewClient), tout en conservant le comportement Capacitor/Cordova
        // standard (routage des plugins, événement deviceready, etc.) via super().
        webView.setWebViewClient(new FssWebViewClient(this.bridge));
    }

    /**
     * Comportement du bouton retour matériel/geste Android — trois niveaux, du plus interne au
     * plus externe, pour ne JAMAIS fermer l'appli sur un appui "retour" qui visait juste à
     * changer d'écran :
     *  1) L'application principale (index.html, écran de caisse) gère elle-même ses propres
     *     "écrans" internes (pages Articles/Stock/Paramètres..., modales) sans navigation WebView
     *     réelle — on lui demande d'abord si CET appui doit fermer une modale ou revenir à l'écran
     *     précédent DANS l'appli (voir window.__fssHandleBack / retourEcranPrecedent() côté JS).
     *  2) Sinon, s'il reste de l'historique de navigation WebView (ex : Choix du rôle -> Connexion
     *     au serveur -> ...), on revient à l'écran précédent. AVANT ce correctif, n'importe quel
     *     appui sur "retour" pendant ces écrans de configuration fermait directement toute
     *     l'application (comportement par défaut d'Android quand rien ne l'intercepte) —
     *     exactement le "je change de page et ça se ferme" signalé.
     *  3) Seulement quand aucun des deux niveaux ci-dessus n'a rien à proposer (donc qu'on est
     *     vraiment sur l'écran d'accueil, sans rien d'ouvert), on demande confirmation avant de
     *     fermer l'appli, plutôt que de la fermer directement sans prévenir.
     */
    @Override
    public void onBackPressed() {
        final WebView webView = (this.bridge != null) ? this.bridge.getWebView() : null;
        if (webView == null) {
            confirmerSortie();
            return;
        }
        // window.__fssHandleBack n'existe que sur l'écran principal (index.html) — absent sur les
        // écrans de configuration (choice/client/server-ip/activation.html), d'où le typeof avant
        // l'appel : sur ces derniers, on tombe directement au niveau 2 (historique WebView).
        String script = "(function(){try{return (typeof window.__fssHandleBack==='function') "
                + "&& window.__fssHandleBack()==='1' ? '1' : '0';}catch(e){return '0';}})()";
        webView.evaluateJavascript(script, (String result) -> {
            boolean geeParLApp = "\"1\"".equals(result);
            if (geeParLApp) return; // Niveau 1 : modale fermée ou écran précédent affiché par le JS.
            if (webView.canGoBack()) {
                webView.goBack(); // Niveau 2.
                return;
            }
            confirmerSortie(); // Niveau 3.
        });
    }

    private void confirmerSortie() {
        new AlertDialog.Builder(this)
                .setTitle("Quitter FSS-CAISSE ?")
                .setMessage("Voulez-vous vraiment fermer l'application ?")
                .setPositiveButton("Quitter", (dialog, which) -> MainActivity.super.onBackPressed())
                .setNegativeButton("Annuler", null)
                .setCancelable(true)
                .show();
    }
}
