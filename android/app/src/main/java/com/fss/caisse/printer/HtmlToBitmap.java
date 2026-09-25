package com.fss.caisse.printer;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
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

    public interface Callback {
        void onBitmap(Bitmap bitmap);
        void onError(String message);
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
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        view.postDelayed(() -> {
                            try {
                                int contentHeightPx = (int) (view.getContentHeight() * view.getScale());
                                if (contentHeightPx <= 0) contentHeightPx = 600;
                                view.measure(
                                        View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                                        View.MeasureSpec.makeMeasureSpec(contentHeightPx, View.MeasureSpec.EXACTLY)
                                );
                                view.layout(0, 0, widthPx, contentHeightPx);

                                Bitmap bitmap = Bitmap.createBitmap(widthPx, contentHeightPx, Bitmap.Config.ARGB_8888);
                                Canvas canvas = new Canvas(bitmap);
                                canvas.drawColor(Color.WHITE);
                                view.draw(canvas);
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
}
