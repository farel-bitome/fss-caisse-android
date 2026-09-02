package com.fss.caisse.printer;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;

/**
 * Convertit le HTML du ticket (généré côté JS, identique à celui utilisé sur la version bureau)
 * en image bitmap, prête à être envoyée à l'imprimante. On réutilise ainsi tel quel tout le
 * rendu (mise en page, gras, séparateurs...) déjà conçu et testé côté web, sans le reproduire en
 * commandes ESC/POS.
 *
 * Largeur par défaut : 384px, qui correspond à un rouleau 58mm à 203dpi (format le plus courant
 * sur les TPE portables Sunmi/H10S). Passer 576 pour du 80mm.
 */
public class HtmlToBitmap {

    public interface Callback {
        void onBitmap(Bitmap bitmap);
        void onError(String message);
    }

    public static void render(android.content.Context context, String html, int widthPx, @NonNull Callback callback) {
        Handler main = new Handler(Looper.getMainLooper());
        main.post(() -> {
            try {
                WebView webView = new WebView(context);
                webView.setInitialScale(100);
                webView.getSettings().setJavaScriptEnabled(false);
                webView.getSettings().setLoadWithOverviewMode(true);
                webView.getSettings().setUseWideViewPort(false);
                webView.setBackgroundColor(Color.WHITE);
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
