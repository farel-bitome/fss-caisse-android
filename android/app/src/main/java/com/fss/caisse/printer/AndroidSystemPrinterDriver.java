package com.fss.caisse.printer;

import android.content.Context;
import android.graphics.Bitmap;
import android.os.Looper;
import android.os.Handler;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayOutputStream;

/**
 * Driver "universel" de dernier recours : passe par le cadre d'impression standard d'Android
 * (android.print.PrintManager) au lieu d'un SDK propriétaire de fabricant.
 *
 * Utilisé quand aucun service imprimante connu (Sunmi, Senraise) n'est détecté sur l'appareil —
 * par exemple une tablette Android générique, une caisse enregistreuse d'une marque non reconnue,
 * ou un TPE dont le service embarqué n'a pas encore de driver dédié dans ce projet. Tout appareil
 * Android expose ce cadre système ; si un service d'impression compatible (fourni par le
 * fabricant, ou une appli tierce comme un pilote ESC/POS générique) y est enregistré, l'utilisateur
 * peut choisir "Imprimer" dans la boîte de dialogue système — contrairement à Sunmi/Senraise, ce
 * n'est donc pas une impression totalement silencieuse, mais ça garantit qu'AUCUN appareil ne se
 * retrouve sans aucun moyen d'imprimer.
 *
 * Même approche que le secours déjà utilisé dans FSS-CALCUL (projet sœur du même éditeur pour les
 * mêmes familles de TPE).
 */
public class AndroidSystemPrinterDriver implements PrinterDriver {

    private static final String TAG = "FSS-SystemPrinter";

    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    // Référence gardée pour que la WebView (et son rendu) ne soit pas détruite par le
    // ramasse-miettes avant la fin du passage au framework d'impression.
    private WebView printWebView;

    public AndroidSystemPrinterDriver(Context context) {
        this.context = context.getApplicationContext();
    }

    @Override
    public String getName() {
        return "Système d'impression Android (universel, secours)";
    }

    @Override
    public boolean isAvailable() {
        // Présent sur tout appareil Android — reste le filet de sécurité qui ne peut jamais
        // manquer, même si l'impression réelle dépend ensuite d'un service compatible installé.
        return true;
    }

    @Override
    public void printBitmap(final Bitmap bitmap, final Callback callback) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    WebView web = new WebView(context);
                    printWebView = web;
                    web.getSettings().setJavaScriptEnabled(false);
                    web.setWebViewClient(new WebViewClient() {
                        @Override
                        public void onPageFinished(WebView view, String url) {
                            try {
                                PrintManager pm = (PrintManager) context.getSystemService(Context.PRINT_SERVICE);
                                if (pm == null) {
                                    callback.onError("Service d'impression système indisponible sur cet appareil.");
                                    return;
                                }
                                android.print.PrintDocumentAdapter adapter =
                                        web.createPrintDocumentAdapter("FSS-CAISSE-Ticket");
                                pm.print(
                                        "FSS-CAISSE",
                                        adapter,
                                        new PrintAttributes.Builder()
                                                .setMediaSize(mediaSizeFor(bitmap.getWidth()))
                                                .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                                                .build()
                                );
                                callback.onSuccess();
                            } catch (Exception e) {
                                Log.e(TAG, "Échec de l'impression système : " + e.getMessage());
                                callback.onError("Échec de l'impression système Android : " + e.getMessage());
                            }
                        }
                    });
                    web.loadDataWithBaseURL(null, buildHtml(bitmap), "text/html", "UTF-8", null);
                } catch (Exception e) {
                    callback.onError("Impossible d'initialiser l'impression système : " + e.getMessage());
                }
            }
        });
    }

    /**
     * Détermine le format de page à partir de la largeur réelle du bitmap rendu (voir
     * HtmlToBitmap : 384px ≈ 58mm, 576px ≈ 80mm à 203dpi) plutôt que de figer 58mm en dur — sinon
     * un ticket rendu en 80mm (choix fait dans l'app) serait tronqué/déformé sur ce driver de
     * secours. Pour une largeur inattendue (autre TPE/DPI), on calcule le format proportionnellement
     * plutôt que de retomber sur une valeur arbitraire.
     */
    private PrintAttributes.MediaSize mediaSizeFor(int bitmapWidthPx) {
        if (bitmapWidthPx <= 0) bitmapWidthPx = 384;
        if (Math.abs(bitmapWidthPx - 384) <= 32) {
            return new PrintAttributes.MediaSize("FSS58", "Ticket 58 mm", 2283, 11690);
        }
        if (Math.abs(bitmapWidthPx - 576) <= 32) {
            return new PrintAttributes.MediaSize("FSS80", "Ticket 80 mm", 3150, 11690);
        }
        // Largeur non standard (autre TPE/DPI) : on déduit la largeur papier en mils en
        // supposant ~203dpi (standard quasi universel des imprimantes thermiques de TPE),
        // pour rester correct même sur du matériel non prévu explicitement ci-dessus.
        int widthMils = (int) Math.round(bitmapWidthPx / 203.0 * 1000);
        return new PrintAttributes.MediaSize("FSS_AUTO", "Ticket " + widthMils + "mils", widthMils, 11690);
    }

    private String buildHtml(Bitmap bitmap) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        String b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        // La largeur d'affichage de l'image suit le format réel (58mm/80mm), calculée à partir
        // de la même hypothèse ~203dpi que mediaSizeFor(), avec une petite marge (4mm) de chaque
        // côté pour rester dans la zone imprimable de la page choisie.
        double widthMm = bitmap.getWidth() / 203.0 * 25.4;
        double imgWidthMm = Math.max(10, widthMm - 4);
        return "<html><head><meta charset=\"utf-8\"><style>"
                + "@page{size:" + fmt(widthMm) + "mm auto;margin:0}body{margin:0;padding:0}"
                + "img{display:block;width:" + fmt(imgWidthMm) + "mm;margin:2mm auto;image-rendering:pixelated}"
                + "</style></head><body><img src=\"data:image/png;base64," + b64 + "\"></body></html>";
    }

    private static String fmt(double mm) {
        return String.format(java.util.Locale.US, "%.1f", mm);
    }
}
