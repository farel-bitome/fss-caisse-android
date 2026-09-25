package com.fss.caisse.printer;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
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
 * IMPORTANT — cause la plus fréquente d'un bitmap totalement BLANC (donc d'une impression qui ne
 * sort jamais, ou sort vierge) avec cette technique "dessiner une WebView dans un Canvas" :
 * WebView est accéléré matériellement par défaut, et View#draw(Canvas) sur une vue accélérée qui
 * n'est PAS attachée à une fenêtre réelle produit très souvent un rendu vide sur Android (bug
 * documenté de longue date, indépendant de la version d'Android). Les deux correctifs nécessaires,
 * appliqués ensemble ci-dessous :
 *   1. Forcer le rendu logiciel (setLayerType(LAYER_TYPE_SOFTWARE, null)) sur cette WebView.
 *   2. Attacher réellement la WebView à la fenêtre de l'Activity (translatée hors de l'écran
 *      visible, jamais en visibility=GONE — une vue GONE n'est ni mesurée ni dessinée par le
 *      système, ce qui recréerait exactement le même bitmap blanc), le temps du rendu, puis la
 *      détacher aussitôt après.
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

    public static void render(Activity activity, String html, int widthPx, @NonNull Callback callback) {
        Handler main = new Handler(Looper.getMainLooper());
        main.post(() -> {
            if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
                callback.onError("Impossible de préparer le rendu du ticket : Activity indisponible.");
                return;
            }
            ViewGroup root;
            try {
                root = activity.getWindow().getDecorView().findViewById(android.R.id.content);
            } catch (Exception e) {
                callback.onError("Impossible d'accéder à la fenêtre de l'application : " + e.getMessage());
                return;
            }
            try {
                WebView webView = new WebView(activity);
                // Voir le commentaire de classe : sans ça, le bitmap final est très souvent blanc.
                webView.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
                webView.setInitialScale(100);
                webView.getSettings().setJavaScriptEnabled(false);
                webView.getSettings().setLoadWithOverviewMode(true);
                webView.getSettings().setUseWideViewPort(false);
                webView.setBackgroundColor(Color.WHITE);

                FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(widthPx, 10);
                webView.setLayoutParams(lp);
                webView.setTranslationX(-100000f); // hors de l'écran visible, jamais GONE
                root.addView(webView);
                webView.layout(0, 0, widthPx, 10);

                webView.setWebViewClient(new WebViewClient() {
                    // IMPORTANT — sans ce recouvrement, si le processus de rendu partagé par TOUTES
                    // les WebViews de l'appli plante (ex : accumulation de rendus rapides pendant
                    // une rafale d'impressions, mémoire limitée d'un TPE), le comportement PAR
                    // DÉFAUT d'Android est de tuer immédiatement TOUTE l'application (documenté :
                    // "the app will crash if the renderer process crashes" quand ce callback n'est
                    // pas recouvert). C'est très probablement la cause exacte du plantage observé
                    // juste après une impression, suivi d'un redémarrage qui reste bloqué sur l'écran
                    // de démarrage. En le recouvrant et en renvoyant true, on signale à Android
                    // qu'on a géré la situation nous-mêmes — l'appli continue de tourner, seule
                    // cette impression échoue proprement (l'utilisateur peut réessayer).
                    @Override
                    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                        Log.e(TAG, "Processus de rendu WebView perdu pendant le rendu d'un ticket "
                                + "(crashed=" + detail.didCrash() + ") — impression annulée sans "
                                + "faire planter l'application.");
                        try { root.removeView(view); } catch (Exception ignored) {}
                        try { view.destroy(); } catch (Exception ignored) {}
                        callback.onError("Le moteur d'affichage a redémarré pendant la préparation du "
                                + "ticket (mémoire limitée de l'appareil ?) — réessayez l'impression.");
                        return true; // Géré ici : ne PAS laisser Android tuer toute l'application.
                    }

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        view.postDelayed(() -> {
                            try {
                                int contentHeightPx = (int) (view.getContentHeight() * view.getScale());
                                if (contentHeightPx <= 0) contentHeightPx = 600;

                                // CAUSE TRÈS PROBABLE d'une impression qui sort BLANCHE (ou avec
                                // seulement quelques pixels en haut) malgré tout le reste : cette
                                // WebView est ajoutée à "root", qui est le vrai décor de l'Activity
                                // ENCORE ACTIVE (celle qui affiche toute l'appli) — donc n'importe
                                // quelle repasse de layout du système déclenchée entretemps par le
                                // reste de l'interface (l'appli continue de tourner pendant qu'on
                                // imprime) reposait cette WebView à sa taille de LayoutParams
                                // d'ORIGINE (voir plus haut : 10px de haut, juste le temps de
                                // charger le HTML), écrasant le layout(0,0,widthPx,contentHeightPx)
                                // qu'on fait ci-dessous À LA MAIN. Résultat : view.draw(canvas)
                                // capture presque uniquement la marge blanche du haut, sur un
                                // canvas par ailleurs correctement rempli de blanc — donc un ticket
                                // qui "sort blanc". On met donc AUSSI à jour les LayoutParams réels
                                // de la vue avec la bonne hauteur, pas seulement measure()/layout(),
                                // pour qu'une repasse système ultérieure retombe sur la bonne taille
                                // au lieu de l'écraser.
                                FrameLayout.LayoutParams finalLp = new FrameLayout.LayoutParams(widthPx, contentHeightPx);
                                view.setLayoutParams(finalLp);
                                view.measure(
                                        View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                                        View.MeasureSpec.makeMeasureSpec(contentHeightPx, View.MeasureSpec.EXACTLY)
                                );
                                view.layout(0, 0, widthPx, contentHeightPx);

                                Bitmap bitmap = Bitmap.createBitmap(widthPx, contentHeightPx, Bitmap.Config.ARGB_8888);
                                Canvas canvas = new Canvas(bitmap);
                                canvas.drawColor(Color.WHITE);
                                view.draw(canvas);

                                if (looksBlank(bitmap)) {
                                    Log.w(TAG, "Bitmap de ticket rendu mais quasi entièrement blanc "
                                            + "(" + bitmap.getWidth() + "x" + bitmap.getHeight() + "px) — "
                                            + "probable raté de rendu, pas un problème d'imprimante.");
                                    try { callback.onSuspectBlank(); } catch (Exception ignored) {}
                                }

                                callback.onBitmap(bitmap);
                            } catch (Exception e) {
                                callback.onError("Erreur de rendu du ticket : " + e.getMessage());
                            } finally {
                                try { root.removeView(view); } catch (Exception ignored) {}
                            }
                        }, 150);
                    }
                });

                webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
            } catch (Exception e) {
                callback.onError("Impossible de préparer le rendu du ticket : " + e.getMessage());
            }
        });
    }

    /**
     * Détection rapide (échantillonnage, pas pixel par pixel) d'un bitmap quasi entièrement
     * blanc — ex: la marge blanche du haut d'un ticket dont le contenu réel n'a jamais été
     * dessiné (voir le commentaire dans onPageFinished ci-dessus). Simple garde-fou de diagnostic :
     * un faux positif/négatif occasionnel n'a aucune conséquence, ça ne fait qu'ajouter un
     * avertissement dans les logs et l'appli.
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
                // Blanc quasi pur (tolérance pour l'anticrénelage du texte) : les trois canaux
                // au-dessus de 250 sont considérés comme du "vide".
                int r = (px >> 16) & 0xFF, g = (px >> 8) & 0xFF, b = px & 0xFF;
                if (r < 250 || g < 250 || b < 250) nonWhite++;
            }
        }
        if (sampled == 0) return true;
        // Un ticket normal (texte + séparateurs) a largement plus de 0,5% de pixels non blancs.
        return (nonWhite * 1000L / sampled) < 5;
    }
}
