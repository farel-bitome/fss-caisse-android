package com.fss.caisse;

import android.Manifest;
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
}
