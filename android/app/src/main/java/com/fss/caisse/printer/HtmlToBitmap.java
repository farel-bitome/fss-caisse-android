package com.fss.caisse.printer;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.ContextWrapper;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
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
 * 3) Fenêtre de rendu hébergée dans un Dialog dédié, attaché à l'Activity principale (positionné
 *    hors-écran, invisible/non interactif) au lieu de la fenêtre décor partagée — corrige le bug
 *    "ticket blanc" de la version 1. MAIS : un Dialog appartient à une Activity, et Android peut
 *    refuser ou perturber la création/mise en page d'une nouvelle fenêtre quand cette Activity
 *    n'est pas au premier plan (écran éteint, appli en arrière-plan) — précisément le cas du rôle
 *    "Serveur" en mode autonome (voir FssServerService), pensé pour tourner en continu SANS écran
 *    allumé. Un bon de commande imprimé automatiquement à la réception d'une commande réseau (pas
 *    d'action de l'utilisateur, donc pas garanti d'avoir l'écran allumé) pouvait ainsi échouer à
 *    s'imprimer sur certains TPE (Senraise H10S constaté), alors qu'un ticket imprimé en tapant
 *    sur un bouton (addition, reçu — toujours avec l'appli au premier plan) fonctionnait très bien.
 *
 * 4) Solution retenue ICI, EN PLUS de la 3) : quand la permission "Afficher par-dessus les autres
 *    applications" (SYSTEM_ALERT_WINDOW / Settings.canDrawOverlays) est accordée, la fenêtre de
 *    rendu est créée directement via WindowManager (TYPE_APPLICATION_OVERLAY), rattachée au
 *    contexte APPLICATIF plutôt qu'à une Activity — ce type de fenêtre système continue de
 *    fonctionner même écran éteint ou appli en arrière-plan, ce qui est exactement le cas d'usage
 *    du rôle "Serveur". Si cette permission n'est PAS accordée, on retombe sur la solution 3)
 *    (Dialog attaché à l'Activity), qui reste nécessaire pour les impressions manuelles (addition,
 *    reçu) et fonctionne très bien tant que l'appli est au premier plan.
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
     * Vrai si l'appli peut créer une fenêtre système par-dessus les autres (nécessaire pour
     * imprimer de façon fiable même écran éteint / appli en arrière-plan, voir point 4 ci-dessus).
     * Exposé pour permettre à l'écran Paramètres de l'appli d'afficher un état et un bouton pour
     * demander cette permission (voir FssNativeBridge).
     */
    public static boolean hasOverlayPermission(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context);
    }

    /**
     * @param context N'importe quel Context. Si la permission d'affichage par-dessus les autres
     *                 applications est accordée, une fenêtre système est créée directement à
     *                 partir du contexte applicatif (fonctionne même écran éteint / en arrière-
     *                 plan). Sinon, ce Context DOIT permettre de remonter jusqu'à une Activity
     *                 vivante et au premier plan (voir findActivity ci-dessous).
     */
    public static void render(Context context, String html, int widthPx, @NonNull Callback callback) {
        android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
        main.post(() -> {
            Context appContext = context.getApplicationContext();
            if (hasOverlayPermission(appContext)) {
                renderViaOverlayWindow(appContext, html, widthPx, callback);
                return;
            }
            Activity activity = findActivity(context);
            if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
                callback.onError("Impossible de préparer l'impression : aucune fenêtre active pour le "
                        + "rendu du ticket, et la permission \"Afficher par-dessus les autres "
                        + "applications\" n'est pas accordée (nécessaire pour imprimer même écran "
                        + "éteint ou appli en arrière-plan, ex. les bons de commande automatiques). "
                        + "Voir Paramètres > Périphériques pour l'accorder.");
                return;
            }
            renderViaActivityDialog(activity, html, widthPx, callback);
        });
    }

    // -----------------------------------------------------------------------------------------
    // Voie 1 (préférée) : fenêtre système (TYPE_APPLICATION_OVERLAY), indépendante de toute
    // Activity — fonctionne même écran éteint ou appli en arrière-plan.
    // -----------------------------------------------------------------------------------------
    private static void renderViaOverlayWindow(Context appContext, String html, int widthPx, Callback callback) {
        WindowManager windowManager = (WindowManager) appContext.getSystemService(Context.WINDOW_SERVICE);
        if (windowManager == null) {
            callback.onError("Impossible de préparer l'impression : service de fenêtrage système indisponible.");
            return;
        }
        WebView webView = null;
        FrameLayout container = null;
        try {
            webView = new WebView(appContext);
            configureWebView(webView);

            container = new FrameLayout(appContext);
            container.addView(webView, new FrameLayout.LayoutParams(widthPx, FrameLayout.LayoutParams.WRAP_CONTENT));

            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                    : WindowManager.LayoutParams.TYPE_SYSTEM_ALERT;
            WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                    widthPx,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    type,
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                            | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.TRANSLUCENT);
            params.gravity = Gravity.TOP | Gravity.START;
            // Très loin hors de l'écran plutôt qu'à taille nulle : certains fabricants annulent
            // silencieusement le rendu d'une fenêtre de taille 0x0.
            params.x = -10000;
            params.y = -10000;

            windowManager.addView(container, params);

            final FrameLayout containerRef = container;
            Runnable dismiss = () -> {
                try { windowManager.removeView(containerRef); } catch (Exception ignored) {}
            };

            prepareBeforeLoad(webView, widthPx);
            attachClientAndLoad(webView, html, widthPx, callback, dismiss);
        } catch (Exception e) {
            try { if (webView != null) webView.destroy(); } catch (Exception ignored) {}
            try { if (container != null) windowManager.removeView(container); } catch (Exception ignored) {}
            callback.onError("Impossible de préparer le rendu du ticket (fenêtre système) : " + e.getMessage());
        }
    }

    // -----------------------------------------------------------------------------------------
    // Voie 2 (repli) : Dialog attaché à une Activity au premier plan — nécessite que l'appli soit
    // visible à l'écran au moment de l'impression (suffisant pour les impressions manuelles).
    // -----------------------------------------------------------------------------------------
    private static void renderViaActivityDialog(Activity activity, String html, int widthPx, Callback callback) {
        Dialog dialog = null;
        WebView webView = null;
        try {
            webView = new WebView(activity);
            configureWebView(webView);

            // IMPORTANT : on crée et affiche la fenêtre hors-écran, de largeur FIXÉE à widthPx,
            // puis on l'attache à la WebView AVANT de charger le HTML — et non après, comme dans
            // une version précédente. Charger le HTML dans une WebView encore détachée de toute
            // fenêtre laisse le moteur de rendu calculer une première fois la mise en page
            // (centrage du texte, largeurs en %) par rapport à une largeur par défaut différente
            // de widthPx ; le redimensionnement ultérieur ne rattrape pas toujours ce calcul sur
            // tous les modèles de TPE.
            dialog = new Dialog(activity, android.R.style.Theme_Translucent_NoTitleBar);
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
                attrs.x = -10000;
                attrs.y = -10000;
                window.setAttributes(attrs);
            }
            dialog.show();

            final Dialog dialogRef = dialog;
            Runnable dismiss = () -> {
                try { dialogRef.dismiss(); } catch (Exception ignored) {}
            };

            // CRUCIAL : dialog.show() ne fait que DEMANDER l'ajout de la fenêtre au système, la
            // vraie mesure/mise en page de son contenu (par ViewRootImpl) n'a lieu qu'à la frame
            // suivante, de façon asynchrone — on force donc ici, de façon SYNCHRONE et immédiate,
            // un measure()+layout() de la WebView à widthPx AVANT tout chargement de contenu.
            prepareBeforeLoad(webView, widthPx);
            attachClientAndLoad(webView, html, widthPx, callback, dismiss);
        } catch (Exception e) {
            try { if (webView != null) webView.destroy(); } catch (Exception ignored) {}
            try { if (dialog != null) dialog.dismiss(); } catch (Exception ignored) {}
            callback.onError("Impossible de préparer le rendu du ticket : " + e.getMessage());
        }
    }

    private static void configureWebView(WebView webView) {
        webView.getSettings().setJavaScriptEnabled(false);
        webView.getSettings().setLoadWithOverviewMode(true);
        webView.getSettings().setUseWideViewPort(false);
        // Rendu logiciel : plus fiable pour un dessin manuel dans un Canvas hors écran que le
        // rendu matériel (qui peut produire un bitmap vide sur certains TPE).
        webView.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
    }

    private static void prepareBeforeLoad(WebView webView, int widthPx) {
        int widthSpec = View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY);
        int placeholderHeightSpec = View.MeasureSpec.makeMeasureSpec(1, View.MeasureSpec.AT_MOST);
        webView.measure(widthSpec, placeholderHeightSpec);
        webView.layout(0, 0, widthPx, Math.max(1, webView.getMeasuredHeight()));
    }

    private static void attachClientAndLoad(WebView webView, String html, int widthPx, Callback callback, Runnable dismiss) {
        webView.setWebViewClient(new WebViewClient() {
            // IMPORTANT — sans ce recouvrement, si le processus de rendu partagé par TOUTES les
            // WebViews de l'appli plante, le comportement PAR DÉFAUT d'Android est de tuer
            // immédiatement TOUTE l'application. En le recouvrant et en renvoyant true, on
            // signale à Android qu'on a géré la situation nous-mêmes — l'appli continue de
            // tourner, seule cette impression échoue proprement (réessayable).
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                Log.e(TAG, "Processus de rendu WebView perdu pendant la préparation d'un ticket "
                        + "(crashed=" + detail.didCrash() + ") — impression annulée sans "
                        + "faire planter l'application.");
                try { view.destroy(); } catch (Exception ignored) {}
                try { dismiss.run(); } catch (Exception ignored) {}
                callback.onError("Le moteur d'affichage a redémarré pendant la préparation du "
                        + "ticket (mémoire limitée de l'appareil ?) — réessayez l'impression.");
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                waitForStableHeightThenCapture(dismiss, view, widthPx, callback, 0, -1, 0);
            }
        });
        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    // Attente de stabilisation de la hauteur réelle du contenu avant capture (voir
    // waitForStableHeightThenCapture ci-dessous) : un ticket court (test) se stabilise dès la
    // première vérification, mais un ticket plus long (addition avec plusieurs articles, bilan de
    // clôture...) peut demander plusieurs passes de rendu interne avant que sa hauteur finale ne
    // soit connue — capturer trop tôt, sur un seul événement de layout, produisait un bitmap à une
    // hauteur intermédiaire (souvent quasi vide) pour ces tickets plus longs, d'où "rien ne sort".
    private static final int STABILITY_CHECK_DELAY_MS = 80;
    private static final int STABILITY_REQUIRED_CONSECUTIVE = 3;
    private static final int STABILITY_MAX_CHECKS = 50; // ~50 x 80ms = 4s max avant capture forcée

    /**
     * Interroge webView.getContentHeight() (hauteur RÉELLE du document HTML chargé, en pixels CSS,
     * indépendante des aléas du layout Android) à intervalles réguliers, jusqu'à ce qu'elle cesse
     * de changer sur plusieurs vérifications consécutives — signe que le rendu interne de la
     * WebView est bien terminé — plutôt que de se fier à un seul événement de layout ponctuel.
     */
    private static void waitForStableHeightThenCapture(Runnable dismiss, WebView webView, int widthPx,
                                                         Callback callback, int attempt,
                                                         int lastContentHeightPx, int stableCount) {
        if (attempt >= STABILITY_MAX_CHECKS) {
            Log.w(TAG, "Délai d'attente de stabilisation du ticket dépassé — capture avec la "
                    + "dernière hauteur connue (" + lastContentHeightPx + "px) plutôt que d'échouer.");
            applyMeasuredHeight(webView, widthPx, lastContentHeightPx);
            finishCapture(dismiss, webView, widthPx, callback);
            return;
        }
        webView.postDelayed(() -> {
            int contentHeightPx = Math.round(webView.getContentHeight() * webView.getScale());
            if (contentHeightPx > 0 && contentHeightPx == lastContentHeightPx) {
                int newStableCount = stableCount + 1;
                if (newStableCount >= STABILITY_REQUIRED_CONSECUTIVE) {
                    applyMeasuredHeight(webView, widthPx, contentHeightPx);
                    finishCapture(dismiss, webView, widthPx, callback);
                    return;
                }
                waitForStableHeightThenCapture(dismiss, webView, widthPx, callback, attempt + 1, contentHeightPx, newStableCount);
            } else {
                waitForStableHeightThenCapture(dismiss, webView, widthPx, callback, attempt + 1, contentHeightPx, 0);
            }
        }, STABILITY_CHECK_DELAY_MS);
    }

    /**
     * Fixe explicitement les dimensions finales du WebView (measure + layout manuels) à la
     * largeur du ticket et à la hauteur RÉELLE du contenu qu'on vient de déterminer — au lieu de
     * se fier au recalcul automatique "wrap_content" d'Android, qui peut se figer trop tôt sur du
     * contenu long.
     */
    private static void applyMeasuredHeight(WebView webView, int widthPx, int heightPx) {
        int finalHeight = Math.max(1, heightPx);
        int widthSpec = View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY);
        int heightSpec = View.MeasureSpec.makeMeasureSpec(finalHeight, View.MeasureSpec.EXACTLY);
        webView.measure(widthSpec, heightSpec);
        webView.layout(0, 0, widthPx, finalHeight);
    }

    private static void finishCapture(Runnable dismiss, WebView webView, int widthPx, Callback callback) {
        try {
            int height = Math.max(1, webView.getHeight());
            Bitmap bitmap = Bitmap.createBitmap(widthPx, height, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            canvas.drawColor(Color.WHITE);
            webView.draw(canvas);
            // Le rendu WebView anti-crénèle le texte (pixels gris sur les contours) : très lisible
            // à l'écran, mais une tête d'impression thermique restitue ce gris comme un texte pâle
            // et peu net. On force chaque pixel en noir pur ou blanc pur pour un ticket net et
            // bien contrasté, quel que soit le réglage de "densité" du pilote imprimante.
            bitmap = blackAndWhiteThreshold(bitmap);
            if (looksBlank(bitmap)) {
                Log.w(TAG, "Bitmap de ticket rendu mais quasi entièrement blanc ("
                        + bitmap.getWidth() + "x" + bitmap.getHeight() + "px).");
                try { callback.onSuspectBlank(); } catch (Exception ignored) {}
            }
            callback.onBitmap(bitmap);
        } catch (Exception e) {
            callback.onError("Erreur lors de la capture du ticket : " + e.getMessage());
        } finally {
            try { dismiss.run(); } catch (Exception ignored) {}
            try { webView.destroy(); } catch (Exception ignored) {}
        }
    }

    /**
     * Seuil de luminance en dessous duquel un pixel devient noir pur (sinon blanc pur). Plus ce
     * seuil est élevé, plus on bascule en noir des pixels gris CLAIRS (pas seulement les gris
     * foncés) — c'est-à-dire les pixels d'anti-crénelage sur les BORDS de chaque lettre, ce qui a
     * pour effet d'épaissir visuellement tous les traits du texte à l'impression (un "gras"
     * renforcé, au-delà de ce que permet déjà font-weight:900 en CSS, dont l'effet réel est
     * limité par les graisses que la police "Courier New" fournit vraiment). Relevé de 180 à 215
     * à la demande explicite d'un texte plus gras PARTOUT (tous les types de tickets, puisque ce
     * seuil s'applique uniformément à chaque bitmap rendu, quel que soit l'appelant).
     */
    private static final int BW_THRESHOLD = 215;

    private static Bitmap blackAndWhiteThreshold(Bitmap source) {
        int w = source.getWidth(), h = source.getHeight();
        int[] pixels = new int[w * h];
        source.getPixels(pixels, 0, w, 0, 0, w, h);
        for (int i = 0; i < pixels.length; i++) {
            int px = pixels[i];
            int a = (px >>> 24) & 0xFF;
            int r = (px >> 16) & 0xFF, g = (px >> 8) & 0xFF, b = px & 0xFF;
            // Un pixel transparent (fond non peint) compte comme blanc, pas comme noir.
            int luminance = a == 0 ? 255 : (int) (0.299 * r + 0.587 * g + 0.114 * b);
            pixels[i] = (luminance < BW_THRESHOLD) ? 0xFF000000 : 0xFFFFFFFF;
        }
        Bitmap result = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        result.setPixels(pixels, 0, w, 0, 0, w, h);
        source.recycle();
        return result;
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
