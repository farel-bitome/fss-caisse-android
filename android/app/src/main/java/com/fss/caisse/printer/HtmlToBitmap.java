package com.fss.caisse.printer;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.ContextWrapper;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;

/**
 * Convertit le HTML du ticket (généré côté JS, identique à celui utilisé sur la version bureau)
 * en image bitmap, prête à être envoyée à l'imprimante. On réutilise ainsi tel quel tout le
 * rendu (mise en page, gras, séparateurs...) déjà conçu et testé côté web, sans le reproduire en
 * commandes ESC/POS.
 *
 * Largeur par défaut : 384px, qui correspond à un rouleau 58mm à 203dpi (format le plus courant
 * sur les TPE portables Sunmi/H10S). Passer 576 pour du 80mm.
 *
 * HISTORIQUE (important pour ne pas reproduire les mêmes erreurs) :
 *
 * 1) Première version : la WebView était attachée directement à la fenêtre DÉCOR de l'Activity
 *    principale (celle, toujours active, de toute l'interface de l'appli) avant d'être dessinée
 *    dans un Canvas. Problème : cette fenêtre est PARTAGÉE avec tout le reste de l'UI — une
 *    repasse de layout du système déclenchée entretemps par le reste de l'interface pouvait
 *    annuler la taille qu'on venait de fixer à la WebView de rendu, d'où des tickets sortis
 *    blancs de façon intermittente malgré plusieurs correctifs successifs sur les LayoutParams.
 *
 * 2) Tentative de contournement via le pipeline OFFICIEL d'impression Android
 *    (WebView#createPrintDocumentAdapter, puis appel manuel de adapter.onLayout()/onWrite() pour
 *    fabriquer un PDF, rasterisé ensuite via PdfRenderer). Cette piste s'est révélée IMPOSSIBLE À
 *    COMPILER : PrintDocumentAdapter.LayoutResultCallback et .WriteResultCallback n'ont PAS de
 *    constructeur public — seul le framework d'impression système (PrintManager, PrintSpooler)
 *    peut créer ces objets et les transmettre à onLayout()/onWrite(). Une appli ne peut donc PAS
 *    piloter elle-même cet adaptateur pour produire un PDF en silence ; elle ne peut l'utiliser
 *    qu'en le confiant à PrintManager.print(...), ce qui affiche la boîte de dialogue système —
 *    exactement ce que fait déjà AndroidSystemPrinterDriver (le secours universel), mais ça ne
 *    convient pas à une impression AUTOMATIQUE et silencieuse sur un TPE.
 *
 * 3) Solution retenue ICI : revenir à la capture directe WebView -> Canvas (comme dans la version
 *    1), mais en corrigeant la VRAIE cause du bug — l'attachement à la fenêtre partagée de
 *    l'Activity. La WebView de rendu est maintenant hébergée dans sa PROPRE fenêtre indépendante
 *    (un Dialog dédié, positionné hors-écran et totalement invisible/non interactif), qui ne
 *    subit donc AUCUNE repasse de layout provoquée par le reste de l'interface. On attend en plus
 *    un vrai événement de layout terminé (ViewTreeObserver) avant de dessiner, au lieu de se fier
 *    à un délai arbitraire.
 */
public class HtmlToBitmap {

    private static final String TAG = "FSS-HtmlToBitmap";

    public interface Callback {
        void onBitmap(Bitmap bitmap);
        void onError(String message);
        /**
         * Appelé EN PLUS de onBitmap (jamais à la place) quand le bitmap produit semble
         * anormalement vide (quasi entièrement blanc) — signe très probable d'un raté de rendu
         * plutôt que d'un problème d'imprimante. Optionnel : laisser vide ne change rien au
         * comportement d'impression, ça sert uniquement à afficher un avertissement utile.
         */
        default void onSuspectBlank() {}
    }

    /**
     * @param context N'importe quel Context ; DOIT permettre de remonter jusqu'à une Activity
     *                 vivante (voir findActivity ci-dessous) — une fenêtre de rendu indépendante
     *                 ne peut être créée que rattachée à une Activity, pas à un simple contexte
     *                 applicatif. En pratique, on passe toujours ici la WebView principale de
     *                 l'appli ou son contexte (voir FssNativeBridge.doPrint()).
     */
    public static void render(Context context, String html, int widthPx, @NonNull Callback callback) {
        Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
        main.post(() -> {
            Activity activity = findActivity(context);
            if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
                callback.onError("Impossible de préparer l'impression : aucune fenêtre active pour le rendu du ticket.");
                return;
            }
            try {
                WebView webView = new WebView(activity);
                webView.getSettings().setJavaScriptEnabled(false);
                webView.getSettings().setLoadWithOverviewMode(true);
                webView.getSettings().setUseWideViewPort(false);
                // Rendu logiciel : plus fiable pour un dessin manuel dans un Canvas hors écran
                // que le rendu matériel (qui peut produire un bitmap vide sur certains TPE).
                webView.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
                webView.setWebViewClient(new WebViewClient() {
                    // IMPORTANT — sans ce recouvrement, si le processus de rendu partagé par TOUTES
                    // les WebViews de l'appli plante, le comportement PAR DÉFAUT d'Android est de
                    // tuer immédiatement TOUTE l'application. En le recouvrant et en renvoyant true,
                    // on signale à Android qu'on a géré la situation nous-mêmes — l'appli continue
                    // de tourner, seule cette impression échoue proprement (réessayable).
                    @Override
                    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                        Log.e(TAG, "Processus de rendu WebView perdu pendant la préparation d'un ticket "
                                + "(crashed=" + detail.didCrash() + ") — impression annulée sans "
                                + "faire planter l'application.");
                        try { view.destroy(); } catch (Exception ignored) {}
                        callback.onError("Le moteur d'affichage a redémarré pendant la préparation du "
                                + "ticket (mémoire limitée de l'appareil ?) — réessayez l'impression.");
                        return true;
                    }

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        captureInOwnWindow(activity, view, widthPx, callback);
                    }
                });
                webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
            } catch (Exception e) {
                callback.onError("Impossible de préparer le rendu du ticket : " + e.getMessage());
            }
        });
    }

    /**
     * Héberge la WebView dans une fenêtre Dialog totalement indépendante de celle de l'Activité
     * (invisible, hors-écran, ni tactile ni focusable) puis attend un VRAI événement de layout
     * terminé — pas un simple délai arbitraire — avant de dessiner le contenu dans un bitmap.
     * Comme cette fenêtre n'appartient qu'à ce rendu et à rien d'autre dans l'appli, aucune
     * repasse de layout déclenchée par le reste de l'interface ne peut plus jamais lui faire
     * perdre sa taille avant la capture (c'était la cause du bug "ticket blanc" historique).
     */
    private static void captureInOwnWindow(Activity activity, WebView webView, int widthPx, Callback callback) {
        try {
            Dialog dialog = new Dialog(activity, android.R.style.Theme_Translucent_NoTitleBar);
            dialog.setCancelable(false);
            FrameLayout container = new FrameLayout(activity);
            container.addView(webView, new FrameLayout.LayoutParams(widthPx, FrameLayout.LayoutParams.WRAP_CONTENT));
            dialog.setContentView(container);

            Window window = dialog.getWindow();
            if (window != null) {
                window.setLayout(widthPx, WindowManager.LayoutParams.WRAP_CONTENT);
                window.setGravity(Gravity.TOP | Gravity.START);
                window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
                window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);
                WindowManager.LayoutParams attrs = window.getAttributes();
                // Très loin hors de l'écran plutôt qu'à taille nulle : certains fabricants
                // annulent silencieusement le rendu d'une fenêtre de taille 0x0.
                attrs.x = -10000;
                attrs.y = -10000;
                window.setAttributes(attrs);
            }

            dialog.show();

            final boolean[] captured = {false};
            webView.getViewTreeObserver().addOnGlobalLayoutListener(new ViewTreeObserver.OnGlobalLayoutListener() {
                @Override
                public void onGlobalLayout() {
                    if (captured[0]) return;
                    if (webView.getWidth() <= 0 || webView.getHeight() <= 0) return;
                    captured[0] = true;
                    try { webView.getViewTreeObserver().removeOnGlobalLayoutListener(this); } catch (Exception ignored) {}
                    // Un post() supplémentaire laisse le passage de DESSIN (pas seulement de
                    // layout) du système se terminer avant qu'on capture le Canvas nous-mêmes.
                    webView.post(() -> finishCapture(dialog, webView, widthPx, callback));
                }
            });
        } catch (Exception e) {
            try { webView.destroy(); } catch (Exception ignored) {}
            callback.onError("Impossible de préparer la fenêtre de rendu du ticket : " + e.getMessage());
        }
    }

    private static void finishCapture(Dialog dialog, WebView webView, int widthPx, Callback callback) {
        try {
            int height = Math.max(1, webView.getHeight());
            Bitmap bitmap = Bitmap.createBitmap(widthPx, height, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            canvas.drawColor(Color.WHITE);
            webView.draw(canvas);
            if (looksBlank(bitmap)) {
                Log.w(TAG, "Bitmap de ticket rendu mais quasi entièrement blanc ("
                        + bitmap.getWidth() + "x" + bitmap.getHeight() + "px).");
                try { callback.onSuspectBlank(); } catch (Exception ignored) {}
            }
            callback.onBitmap(bitmap);
        } catch (Exception e) {
            callback.onError("Erreur lors de la capture du ticket : " + e.getMessage());
        } finally {
            try { dialog.dismiss(); } catch (Exception ignored) {}
            try { webView.destroy(); } catch (Exception ignored) {}
        }
    }

    /** Remonte la chaîne des ContextWrapper pour retrouver l'Activity sous-jacente, s'il y en a une. */
    private static Activity findActivity(Context context) {
        Context c = context;
        while (c instanceof ContextWrapper) {
            if (c instanceof Activity) return (Activity) c;
            c = ((ContextWrapper) c).getBaseContext();
        }
        return (c instanceof Activity) ? (Activity) c : null;
    }

    /**
     * Détection rapide (échantillonnage, pas pixel par pixel) d'un bitmap quasi entièrement
     * blanc. Simple garde-fou de diagnostic : un faux positif/négatif occasionnel n'a aucune
     * conséquence, ça ne fait qu'ajouter un avertissement dans les logs et l'appli.
     */
    private static boolean looksBlank(Bitmap bitmap) {
        int w = bitmap.getWidth(), h = bitmap.getHeight();
        if (w <= 0 || h <= 0) return true;
        int stepX = Math.max(1, w / 40);
        int stepY = Math.max(1, h / 200);
        int sampled = 0, nonWhite = 0;
        for (int y = 0; y < h; y += stepY) {
            for (int x = 0; x < w; x += stepX) {
                int px = bitmap.getPixel(x, y);
                sampled++;
                int r = (px >> 16) & 0xFF, g = (px >> 8) & 0xFF, b = px & 0xFF;
                if (r < 250 || g < 250 || b < 250) nonWhite++;
            }
        }
        if (sampled == 0) return true;
        // Un ticket normal (texte + séparateurs) a largement plus de 0,5% de pixels non blancs.
        return (nonWhite * 1000L / sampled) < 5;
    }
}
