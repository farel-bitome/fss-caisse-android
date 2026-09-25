package com.fss.caisse.printer;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;

import java.io.File;

/**
 * Convertit le HTML du ticket (généré côté JS, identique à celui utilisé sur la version bureau)
 * en image bitmap, prête à être envoyée à l'imprimante. On réutilise ainsi tel quel tout le
 * rendu (mise en page, gras, séparateurs...) déjà conçu et testé côté web, sans le reproduire en
 * commandes ESC/POS.
 *
 * Largeur par défaut : 384px, qui correspond à un rouleau 58mm à 203dpi (format le plus courant
 * sur les TPE portables Sunmi/H10S). Passer 576 pour du 80mm.
 *
 * MÉTHODE — alignée sur celle qui a fait ses preuves dans FSS-CALCUL (même éditeur, mêmes
 * terminaux Sunmi et Senraise H10S, même besoin exact : transformer un ticket en bitmap pour les
 * SDK imprimante) : la première version de cette classe dessinait "à la main" une WebView dans un
 * Canvas (WebView#draw), une technique fragile qui exige que la vue soit à la fois attachée à une
 * fenêtre réelle ET conserve la bonne taille jusqu'à la capture. Comme cette fenêtre est celle,
 * TOUJOURS ACTIVE, de l'appli entière, une repasse de layout du système déclenchée entretemps par
 * le reste de l'interface pouvait annuler la taille qu'on venait de fixer — d'où des tickets sortis
 * blancs malgré plusieurs correctifs successifs.
 *
 * On passe maintenant par le pipeline d'impression OFFICIEL d'Android
 * (WebView#createPrintDocumentAdapter), le même que celui déjà utilisé par le secours "impression
 * système" de FSS-CAISSE (AndroidSystemPrinterDriver) ET par FSS-CALCUL pour son propre secours
 * Android : il génère un vrai PDF à partir du HTML, en s'appuyant sur le moteur de rendu interne
 * de la WebView, INDÉPENDAMMENT de tout attachement à une fenêtre visible ou de toute repasse de
 * layout système. On rasterise ensuite ce PDF en bitmap avec PdfRenderer (API Android standard).
 * Le CSS de chaque ticket (@page{size:Xmm auto}) garantit que le PDF produit tient sur une seule
 * page, à la largeur voulue.
 */
public class HtmlToBitmap {

    private static final String TAG = "FSS-HtmlToBitmap";

    /** Résolution standard des imprimantes thermiques utilisées sur ces TPE. */
    private static final int DPI = 203;

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

    public static void render(Context context, String html, int widthPx, @NonNull Callback callback) {
        final Context appContext = context.getApplicationContext();
        Handler main = new Handler(Looper.getMainLooper());
        main.post(() -> {
            try {
                WebView webView = new WebView(appContext);
                webView.getSettings().setJavaScriptEnabled(false);
                webView.getSettings().setLoadWithOverviewMode(true);
                webView.getSettings().setUseWideViewPort(false);
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
                        renderToPdfThenBitmap(appContext, view, widthPx, callback);
                    }
                });
                webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
            } catch (Exception e) {
                callback.onError("Impossible de préparer le rendu du ticket : " + e.getMessage());
            }
        });
    }

    private static void renderToPdfThenBitmap(Context context, WebView webView, int widthPx, Callback callback) {
        File pdfFile;
        try {
            pdfFile = File.createTempFile("fss-ticket-", ".pdf", context.getCacheDir());
        } catch (Exception e) {
            try { webView.destroy(); } catch (Exception ignored) {}
            callback.onError("Impossible de créer le fichier temporaire du ticket : " + e.getMessage());
            return;
        }

        try {
            // px -> mils (millièmes de pouce), unité attendue par PrintAttributes.MediaSize.
            int widthMils = Math.round(widthPx * 1000f / DPI);
            // Hauteur "plafond" très généreuse (~1,27 m) : le CSS de chaque ticket fixe déjà
            // @page{size:Xmm auto}, donc le moteur de rendu calcule lui-même la hauteur réelle du
            // contenu — cette valeur n'est qu'une limite haute, jamais atteinte en pratique.
            int heightMils = 50000;

            PrintAttributes attrs = new PrintAttributes.Builder()
                    .setMediaSize(new PrintAttributes.MediaSize("fss_ticket", "Ticket FSS-CAISSE", widthMils, heightMils))
                    .setResolution(new PrintAttributes.Resolution("fss_dpi", "Ticket", DPI, DPI))
                    .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                    .build();

            PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter("fss-ticket");

            adapter.onLayout(null, attrs, new CancellationSignal(), new PrintDocumentAdapter.LayoutResultCallback() {
                @Override
                public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                    writePdf(adapter, pdfFile, webView, widthPx, callback);
                }

                @Override
                public void onLayoutFailed(CharSequence error) {
                    cleanup(webView, pdfFile);
                    callback.onError("Échec de mise en page du ticket : " + error);
                }

                @Override
                public void onLayoutCancelled() {
                    cleanup(webView, pdfFile);
                    callback.onError("Mise en page du ticket annulée.");
                }
            }, new Bundle());
        } catch (Exception e) {
            cleanup(webView, pdfFile);
            callback.onError("Erreur lors de la génération du PDF du ticket : " + e.getMessage());
        }
    }

    private static void writePdf(PrintDocumentAdapter adapter, File pdfFile, WebView webView, int widthPx, Callback callback) {
        ParcelFileDescriptor pfd;
        try {
            pfd = ParcelFileDescriptor.open(pdfFile,
                    ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_TRUNCATE);
        } catch (Exception e) {
            cleanup(webView, pdfFile);
            callback.onError("Impossible d'ouvrir le fichier temporaire du ticket : " + e.getMessage());
            return;
        }
        try {
            adapter.onWrite(new PageRange[]{PageRange.ALL_PAGES}, pfd, new CancellationSignal(),
                    new PrintDocumentAdapter.WriteResultCallback() {
                        @Override
                        public void onWriteFinished(PageRange[] pages) {
                            try { pfd.close(); } catch (Exception ignored) {}
                            try {
                                Bitmap bitmap = rasterizePdf(pdfFile, widthPx);
                                if (looksBlank(bitmap)) {
                                    Log.w(TAG, "Bitmap de ticket rendu mais quasi entièrement blanc "
                                            + "(" + bitmap.getWidth() + "x" + bitmap.getHeight() + "px).");
                                    try { callback.onSuspectBlank(); } catch (Exception ignored2) {}
                                }
                                callback.onBitmap(bitmap);
                            } catch (Exception e) {
                                callback.onError("Erreur de rasterisation du ticket : " + e.getMessage());
                            } finally {
                                cleanup(webView, pdfFile);
                            }
                        }

                        @Override
                        public void onWriteFailed(CharSequence error) {
                            try { pfd.close(); } catch (Exception ignored) {}
                            cleanup(webView, pdfFile);
                            callback.onError("Échec d'écriture du PDF du ticket : " + error);
                        }

                        @Override
                        public void onWriteCancelled() {
                            try { pfd.close(); } catch (Exception ignored) {}
                            cleanup(webView, pdfFile);
                            callback.onError("Écriture du ticket annulée.");
                        }
                    });
        } catch (Exception e) {
            try { pfd.close(); } catch (Exception ignored) {}
            cleanup(webView, pdfFile);
            callback.onError("Erreur lors de l'écriture du PDF du ticket : " + e.getMessage());
        }
    }

    private static void cleanup(WebView webView, File pdfFile) {
        try { webView.destroy(); } catch (Exception ignored) {}
        try { if (pdfFile != null) pdfFile.delete(); } catch (Exception ignored) {}
    }

    /**
     * Ouvre le PDF généré par le pipeline d'impression et le transforme en bitmap à la largeur
     * voulue. Un ticket normal tient sur une seule page grâce à @page{size:Xmm auto} dans le CSS ;
     * si le contenu déborde malgré tout sur plusieurs pages, on les empile verticalement plutôt
     * que de perdre silencieusement la suite du ticket.
     */
    private static Bitmap rasterizePdf(File pdfFile, int widthPx) throws Exception {
        try (ParcelFileDescriptor pfd = ParcelFileDescriptor.open(pdfFile, ParcelFileDescriptor.MODE_READ_ONLY);
             PdfRenderer renderer = new PdfRenderer(pfd)) {
            int pageCount = renderer.getPageCount();
            if (pageCount <= 0) {
                throw new IllegalStateException("PDF généré vide (aucune page) — le rendu du ticket a échoué.");
            }
            Bitmap[] pageBitmaps = new Bitmap[pageCount];
            int totalHeight = 0;
            for (int i = 0; i < pageCount; i++) {
                PdfRenderer.Page page = renderer.openPage(i);
                try {
                    float scale = widthPx / (float) page.getWidth();
                    int h = Math.max(1, Math.round(page.getHeight() * scale));
                    Bitmap pageBitmap = Bitmap.createBitmap(widthPx, h, Bitmap.Config.ARGB_8888);
                    Canvas c = new Canvas(pageBitmap);
                    c.drawColor(Color.WHITE);
                    page.render(pageBitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_PRINT);
                    pageBitmaps[i] = pageBitmap;
                    totalHeight += h;
                } finally {
                    page.close();
                }
            }
            if (pageCount == 1) return pageBitmaps[0];
            Bitmap combined = Bitmap.createBitmap(widthPx, totalHeight, Bitmap.Config.ARGB_8888);
            Canvas cc = new Canvas(combined);
            cc.drawColor(Color.WHITE);
            int y = 0;
            for (Bitmap pb : pageBitmaps) {
                cc.drawBitmap(pb, 0, y, null);
                y += pb.getHeight();
                pb.recycle();
            }
            return combined;
        }
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
