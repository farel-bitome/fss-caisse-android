package com.fss.caisse;

import android.webkit.WebResourceRequest;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/**
 * Étend le WebViewClient de Capacitor (pour ne rien casser côté plugins/cordova) et y ajoute
 * l'injection du pont android-bridge.js sur CHAQUE page chargée, y compris les pages venant du
 * serveur embarqué local (http://127.0.0.1:3000) ou d'un serveur PC distant en LAN — pages qui
 * ne font PAS partie du "bundle" Capacitor et n'ont donc normalement pas accès à
 * Capacitor.Plugins. C'est ce qui permet à toute l'interface existante (index.html, network.js…)
 * de fonctionner sans modification, comme avec preload.js sous Electron.
 */
public class FssWebViewClient extends BridgeWebViewClient {

    public FssWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        // Par défaut, Capacitor fait sortir toute navigation en dehors de son propre bundle
        // (une protection pensée pour ne pas charger du contenu web non maîtrisé dans l'appli)
        // vers le navigateur externe — c'est exactement ce qui empêchait 127.0.0.1:3000 et le
        // serveur PC en LAN de s'ouvrir dans l'appli. Ici ces adresses sont entièrement
        // pilotées par l'appli elle-même (jamais un lien cliqué par l'utilisateur), donc on
        // charge toujours dans notre propre WebView, jamais dans un navigateur externe.
        return false;
    }

    @Override
    public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
        super.onPageStarted(view, url, favicon);
        injectBridge(view);
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        // Deuxième injection de sécurité : certaines pages exécutent des scripts inline très tôt
        // pendant le parsing, avant que onPageStarted n'ait pu s'exécuter à temps.
        injectBridge(view);
    }

    private void injectBridge(WebView view) {
        view.evaluateJavascript(AndroidBridgeScript.SOURCE, null);
    }
}
