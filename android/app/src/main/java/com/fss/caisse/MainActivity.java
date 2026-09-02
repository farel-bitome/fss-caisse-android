package com.fss.caisse;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

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
}
