package com.fss.caisse;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.annotation.NonNull;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import com.fss.caisse.printer.HtmlToBitmap;
import com.fss.caisse.printer.PrinterDriver;
import com.fss.caisse.printer.PrinterDriverFactory;

/**
 * Pont JS <-> natif exposé sur la WebView via addJavascriptInterface (donc disponible sur
 * TOUTE page chargée dans cette WebView, y compris après navigation vers le serveur embarqué
 * local ou vers un serveur PC distant en LAN — contrairement au système de plugins Capacitor,
 * limité à l'origine "bundle" de l'appli).
 *
 * C'est l'équivalent Android de preload.js (Electron). Chaque méthode "invoke" correspond à une
 * entrée de contextBridge.exposeInMainWorld('electronAPI', ...) côté bureau.
 *
 * Toutes les méthodes sont asynchrones par construction : le JS appelle invoke(method, argsJson,
 * callbackId), le natif répond plus tard via evaluateJavascript("window.__fssCallback(id,json)").
 */
public class FssNativeBridge {

    private static final String TAG = "FSS-NativeBridge";
    private static final String PREFS = "fss_caisse_config";

    private final Context context;
    private final WebView webView;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService bg = Executors.newCachedThreadPool();
    private final Licensing licensing;

    public FssNativeBridge(Context context, WebView webView) {
        this.context = context.getApplicationContext();
        this.webView = webView;
        this.licensing = new Licensing(this.context);
    }

    private SharedPreferences prefs() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void respond(final String callbackId, final JSONObject result) {
        mainHandler.post(() -> {
            String json = result == null ? "null" : result.toString();
            String js = "window.__fssCallback && window.__fssCallback(" + JSONObject.quote(callbackId) + "," + JSONObject.quote(json) + ")";
            webView.evaluateJavascript(js, null);
        });
    }

    private JSONObject ok() {
        try { return new JSONObject().put("success", true); } catch (Exception e) { return new JSONObject(); }
    }

    private JSONObject error(String message) {
        try { return new JSONObject().put("success", false).put("error", message); } catch (Exception e) { return new JSONObject(); }
    }

    /** Point d'entrée unique appelé depuis android-bridge.js : FssNativeBridge.invoke(method, argsJson, callbackId) */
    @JavascriptInterface
    public void invoke(final String method, final String argsJson, final String callbackId) {
        bg.execute(() -> {
            try {
                JSONObject args = argsJson == null || argsJson.isEmpty() ? new JSONObject() : new JSONObject(argsJson);
                handle(method, args, callbackId);
            } catch (Exception e) {
                Log.e(TAG, "Erreur pont natif (" + method + ") : " + e.getMessage(), e);
                respond(callbackId, error(e.getMessage()));
            }
        });
    }

    private void handle(String method, JSONObject args, String callbackId) throws Exception {
        switch (method) {
            case "getBootConfig": {
                SharedPreferences p = prefs();
                JSONObject r = new JSONObject();
                r.put("role", p.getString("role", null));
                r.put("serverUrl", p.getString("serverUrl", null));
                boolean blocked = licensing.isBlocked();
                boolean licensed = licensing.isLicensed();
                JSONObject trial = licensing.getTrialStatus();
                r.put("blocked", blocked);
                r.put("licensed", licensed);
                r.put("trial", trial);
                if (!blocked && !licensed) {
                    final long daysLeft = trial.optLong("daysLeft", 0);
                    mainHandler.post(() -> Toast.makeText(context,
                            "Version d'essai — " + daysLeft + " jour(s) restant(s) avant activation obligatoire.",
                            Toast.LENGTH_LONG).show());
                }
                respond(callbackId, r);
                break;
            }
            case "chooseRole": {
                String role = args.optString("role", "");
                prefs().edit().putString("role", role).apply();
                respond(callbackId, ok());
                break;
            }
            case "saveServer": {
                String ip = args.optString("ip", "");
                int port = args.optInt("port", 3000);
                String url = "http://" + ip + ":" + port + "/";
                prefs().edit().putString("role", "client").putString("serverUrl", url).apply();
                stopServerServiceInternal();
                respond(callbackId, ok());
                break;
            }
            case "startServerService": {
                Intent intent = new Intent(context, FssServerService.class);
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    context.startForegroundService(intent);
                } else {
                    context.startService(intent);
                }
                respond(callbackId, ok());
                break;
            }
            case "stopServerService": {
                stopServerServiceInternal();
                respond(callbackId, ok());
                break;
            }
            case "getStartupLog": {
                // Journal écrit par nodejs-project/main.js, indépendant du canal
                // cordova.channel — lu directement sur le disque pour rester consultable même
                // si la communication temps réel avec Node ne fonctionne pas.
                JSONObject r = new JSONObject();
                try {
                    File logFile = new File(context.getFilesDir(), "fss-data/startup.log");
                    if (logFile.exists()) {
                        byte[] data = new byte[(int) logFile.length()];
                        try (java.io.FileInputStream fis = new java.io.FileInputStream(logFile)) {
                            fis.read(data);
                        }
                        r.put("content", new String(data, "UTF-8"));
                    } else {
                        r.put("content", "(fichier startup.log introuvable — main.js n'a peut-être jamais été exécuté)");
                    }
                } catch (Exception e) {
                    r.put("content", "Erreur de lecture du journal : " + e.getMessage());
                }
                respond(callbackId, r);
                break;
            }
            case "getNativePluginLog": {
                // Journal écrit directement par le plugin natif nodejs-mobile-cordova (patché
                // par scripts/patch-nodejs-plugin-diagnostics.js) — pluginInitialize(),
                // asyncInit(), copyNodeJSAssets() et execute(). Contrairement à startup.log
                // (écrit par NOTRE main.js, donc seulement si Node a pu démarrer), celui-ci
                // existe dès que le plugin natif lui-même est sollicité, même si l'extraction
                // des assets plante avant d'avoir jamais atteint main.js — c'est ce qui a permis
                // d'identifier la cause du blocage silencieux du mode autonome (voir
                // build-android.yml : "Copier les assets natifs du plugin").
                JSONObject r = new JSONObject();
                try {
                    File logFile = new File(context.getFilesDir(), "fss-data/native-plugin.log");
                    if (logFile.exists()) {
                        byte[] data = new byte[(int) logFile.length()];
                        try (java.io.FileInputStream fis = new java.io.FileInputStream(logFile)) {
                            fis.read(data);
                        }
                        r.put("content", new String(data, "UTF-8"));
                    } else {
                        r.put("content", "(fichier native-plugin.log introuvable — le plugin NodeJS natif n'a peut-être jamais été sollicité)");
                    }
                } catch (Exception e) {
                    r.put("content", "Erreur de lecture du journal natif : " + e.getMessage());
                }
                respond(callbackId, r);
                break;
            }
            case "getNodeDiagnostics": {
                // Diagnostic 100% natif (Java), qui ne dépend ni de Node ni du canal
                // cordova-bridge — utile quand startup.log lui-même n'apparaît jamais, ce qui
                // signifie que main.js n'a probablement jamais été exécuté DU TOUT. Ça répond à
                // trois questions : le dossier nodejs-project a-t-il seulement été extrait sur
                // le disque du TPE ? Contient-il le bon main.js (celui qu'on vient de recompiler,
                // pas une vieille copie) ? Les bibliothèques natives du moteur Node sont-elles
                // présentes pour l'ABI de cet appareil ?
                respond(callbackId, buildNodeDiagnostics());
                break;
            }
            case "getCurrentServer": {
                JSONObject r = new JSONObject();
                r.put("url", prefs().getString("serverUrl", ""));
                respond(callbackId, r);
                break;
            }
            case "getServerIpInfo": {
                JSONObject r = new JSONObject();
                r.put("detected", getLocalIp());
                r.put("port", 3000);
                SharedPreferences p = prefs();
                boolean manual = p.contains("manualIp");
                r.put("manual", manual);
                r.put("manualIp", p.getString("manualIp", ""));
                r.put("manualPort", p.getInt("manualPort", 3000));
                respond(callbackId, r);
                break;
            }
            case "saveManualIp": {
                prefs().edit()
                        .putString("manualIp", args.optString("ip", ""))
                        .putInt("manualPort", args.optInt("port", 3000))
                        .apply();
                respond(callbackId, ok());
                break;
            }
            case "resetManualIp": {
                prefs().edit().remove("manualIp").remove("manualPort").apply();
                respond(callbackId, ok());
                break;
            }
            case "reloadApp": {
                // La navigation est gérée côté JS (android-bridge.js appelle __fssBoot()) ;
                // on confirme juste la réception ici.
                respond(callbackId, ok());
                break;
            }
            case "getMachineId": {
                JSONObject r = new JSONObject();
                r.put("id", licensing.getMachineId());
                respond(callbackId, r);
                break;
            }
            case "isLicensed": {
                JSONObject r = new JSONObject();
                r.put("licensed", licensing.isLicensed());
                respond(callbackId, r);
                break;
            }
            case "getTrialStatus": {
                respond(callbackId, licensing.getTrialStatus());
                break;
            }
            case "activateLicense": {
                respond(callbackId, licensing.activate(args.optString("key", "")));
                break;
            }
            case "printSilent": {
                String format = args.optString("format", "80mm");
                int widthPx = "58mm".equals(format) ? 384 : 576; // 203dpi : 58mm≈384px, 80mm≈576px
                doPrint(args.optString("html", ""), widthPx, callbackId);
                break;
            }
            case "getPrinterInfo": {
                // Le menu "Type d'imprimante" des Paramètres (USB/Bluetooth/Réseau) est un réglage
                // hérité de la version bureau, jamais lu par le code d'impression Android — sans
                // ça, l'utilisateur n'a aucun moyen de savoir QUEL pilote est réellement utilisé
                // sur son TPE. On expose ici la vraie détection de PrinterDriverFactory.
                JSONObject r = new JSONObject();
                try {
                    PrinterDriver driver = PrinterDriverFactory.get(context);
                    r.put("name", driver.getName());
                    r.put("available", driver.isAvailable());
                } catch (Exception e) {
                    r.put("name", "Erreur de détection : " + e.getMessage());
                    r.put("available", false);
                }
                respond(callbackId, r);
                break;
            }
            case "saveFileDialog": {
                doSaveFile(args, callbackId);
                break;
            }
            case "listBackups": {
                doListBackups(callbackId);
                break;
            }
            case "createBackup": {
                doCreateBackup(args, callbackId);
                break;
            }
            case "readBackup": {
                doReadBackup(args, callbackId);
                break;
            }
            case "openBackupFileDialog": {
                // Nécessite un flux de sélection de fichier (Storage Access Framework) piloté
                // depuis une Activity ; non branché dans ce squelette.
                respond(callbackId, error("Sélection manuelle de fichier non disponible sur TPE."));
                break;
            }
            default:
                respond(callbackId, error("Méthode inconnue : " + method));
        }
    }

    // ---------------------------------------------------------------------------------------
    // Impression : rend le HTML du ticket en bitmap puis l'envoie au driver du fabricant du TPE.
    // ---------------------------------------------------------------------------------------
    private void doPrint(String html, int widthPx, String callbackId) {
        final PrinterDriver driver = PrinterDriverFactory.get(context);
        // Certains TPE (Senraise H10S/H10P) n'ont qu'un module thermique 58mm : un ticket généré
        // par défaut en 80mm (les bons de commande cuisine, les tickets de prélèvement et le bilan
        // de clôture ne proposent pas de choix de format côté JS, contrairement au reçu client et
        // à l'addition) ne sortirait alors jamais — voir PrinterDriver.getMaxWidthPx(). On réduit
        // donc la largeur ICI, avant même de générer le bitmap, quel que soit le format demandé.
        int maxWidthPx = driver.getMaxWidthPx();
        final int effectiveWidthPx = (maxWidthPx > 0 && widthPx > maxWidthPx) ? maxWidthPx : widthPx;
        if (effectiveWidthPx != widthPx) {
            Log.w(TAG, "Largeur d'impression réduite de " + widthPx + "px à " + effectiveWidthPx
                    + "px (limite physique de " + driver.getName() + ").");
        }
        // Rempli par onSuspectBlank() (voir HtmlToBitmap) si le bitmap rendu semble quasi
        // entièrement blanc — permet de renvoyer un avertissement explicite au JS même quand le
        // driver imprimante répond "succès" (il a bien reçu et imprimé l'image... qui était vide
        // dès le rendu). Sans ça, "impression réussie" masquait un ticket blanc sorti du rendu.
        final boolean[] suspectBlank = {false};
        HtmlToBitmap.render(context, html, effectiveWidthPx, new HtmlToBitmap.Callback() {
            @Override
            public void onSuspectBlank() {
                suspectBlank[0] = true;
            }

            @Override
            public void onBitmap(final Bitmap bitmap) {
                // HtmlToBitmap.render() termine sur le thread UI (nécessaire pour dessiner la
                // WebView de rendu). Certains drivers (Senraise/H10S) enchaînent plusieurs appels
                // AIDL SYNCHRONES (une par tranche de bitmap découpée, voir H10sPrinterDriver) —
                // les exécuter directement ici bloquerait le thread UI et risquerait un ANR sur un
                // ticket long. On repasse donc sur le thread de fond avant d'appeler le driver.
                bg.execute(() -> driver.printBitmap(bitmap, new PrinterDriver.Callback() {
                    @Override
                    public void onSuccess() {
                        respond(callbackId, suspectBlank[0]
                                ? error("Le ticket a été envoyé à l'imprimante, mais son rendu était "
                                        + "quasiment vide (page blanche) avant même l'impression — "
                                        + "ce n'est pas l'imprimante qui est en cause ici, réessayez ; "
                                        + "si ça persiste, ce diagnostic doit être transmis au développeur.")
                                : ok());
                    }

                    @Override
                    public void onError(String message) {
                        Log.e(TAG, "Impression échouée (" + driver.getName() + ") : " + message);
                        // Le driver du fabricant détecté n'a pas réussi à imprimer (service pas
                        // encore lié au tout premier essai, panne du service embarqué, etc.) —
                        // plutôt que de renvoyer directement l'erreur, on retente une seule fois
                        // via le secours universel (impression système Android), qui fonctionne
                        // sur n'importe quel appareil. On ne bascule que si ce n'est pas déjà le
                        // driver universel qui vient d'échouer (sinon boucle infinie).
                        PrinterDriver universel = PrinterDriverFactory.universalFallback(context);
                        if (driver == universel) {
                            respond(callbackId, error(message));
                            return;
                        }
                        Log.w(TAG, "Repli sur l'impression système Android après échec de " + driver.getName());
                        bg.execute(() -> universel.printBitmap(bitmap, new PrinterDriver.Callback() {
                            @Override
                            public void onSuccess() { respond(callbackId, ok()); }

                            @Override
                            public void onError(String message2) {
                                respond(callbackId, error(message + " (secours système Android également en échec : " + message2 + ")"));
                            }
                        }));
                    }
                }));
            }

            @Override
            public void onError(String message) {
                respond(callbackId, error(message));
            }
        });
    }

    // ---------------------------------------------------------------------------------------
    // Fichiers : équivalent simplifié des dialogues Electron. Sur Android, on enregistre
    // directement dans le dossier public "Documents/FSS-CAISSE" plutôt que d'ouvrir un
    // sélecteur (les TPE n'ont généralement pas d'explorateur de fichiers pratique).
    // ---------------------------------------------------------------------------------------
    private File exportDir() {
        File dir = new File(context.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS), "FSS-CAISSE");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private void doSaveFile(JSONObject args, String callbackId) {
        try {
            String name = args.optString("defaultName", "export.csv");
            String content = args.optString("content", "");
            boolean isBase64 = args.optBoolean("isBase64", false);
            File out = new File(exportDir(), name);
            try (FileOutputStream fos = new FileOutputStream(out)) {
                fos.write(isBase64 ? Base64.decode(content, Base64.DEFAULT) : content.getBytes("UTF-8"));
            }
            JSONObject r = ok();
            r.put("filePath", out.getAbsolutePath());
            respond(callbackId, r);
        } catch (Exception e) {
            respond(callbackId, error(e.getMessage()));
        }
    }

    private File backupsDir() {
        File dir = new File(context.getFilesDir(), "backups");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private void doListBackups(String callbackId) {
        try {
            File[] files = backupsDir().listFiles((d, n) -> n.endsWith(".json"));
            JSONArray arr = new JSONArray();
            if (files != null) {
                for (File f : files) {
                    JSONObject b = new JSONObject();
                    b.put("filename", f.getName());
                    b.put("date", new java.util.Date(f.lastModified()).toString());
                    b.put("size", f.length());
                    b.put("type", f.getName().startsWith("auto_") ? "Auto" : "Manuel");
                    arr.put(b);
                }
            }
            JSONObject r = ok();
            r.put("backups", arr);
            respond(callbackId, r);
        } catch (Exception e) {
            respond(callbackId, error(e.getMessage()));
        }
    }

    private void doCreateBackup(JSONObject args, String callbackId) {
        try {
            String stateJson = args.optString("stateJson", "{}");
            String type = args.optString("type", "manuel");
            String prefix = "auto".equals(type) ? "auto_" : "manuel_";
            String filename = prefix + UUID.randomUUID() + ".json";
            File out = new File(backupsDir(), filename);
            try (FileOutputStream fos = new FileOutputStream(out)) {
                fos.write(stateJson.getBytes("UTF-8"));
            }
            JSONObject r = ok();
            r.put("filename", filename);
            r.put("date", new java.util.Date(out.lastModified()).toString());
            r.put("size", out.length());
            respond(callbackId, r);
        } catch (Exception e) {
            respond(callbackId, error(e.getMessage()));
        }
    }

    private void doReadBackup(JSONObject args, String callbackId) {
        try {
            String filename = new File(args.optString("filename", "")).getName(); // anti path traversal
            File f = new File(backupsDir(), filename);
            byte[] data = new byte[(int) f.length()];
            try (java.io.FileInputStream fis = new java.io.FileInputStream(f)) {
                fis.read(data);
            }
            JSONObject r = ok();
            r.put("content", new String(data, "UTF-8"));
            respond(callbackId, r);
        } catch (Exception e) {
            respond(callbackId, error(e.getMessage()));
        }
    }

    // ---------------------------------------------------------------------------------------
    private void stopServerServiceInternal() {
        context.stopService(new Intent(context, FssServerService.class));
    }

    private String getLocalIp() {
        try {
            java.util.Enumeration<java.net.NetworkInterface> ifaces = java.net.NetworkInterface.getNetworkInterfaces();
            while (ifaces.hasMoreElements()) {
                java.net.NetworkInterface iface = ifaces.nextElement();
                java.util.Enumeration<java.net.InetAddress> addrs = iface.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    java.net.InetAddress addr = addrs.nextElement();
                    if (!addr.isLoopbackAddress() && addr instanceof java.net.Inet4Address) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    /**
     * Diagnostic natif indépendant de Node, pour le cas où startup.log lui-même n'apparaît
     * jamais (donc main.js n'a peut-être jamais démarré du tout). Répond à trois questions,
     * chacune avec ce qu'on a réellement trouvé sur le disque de l'appareil, pas une supposition :
     *   1) Le dossier nodejs-project a-t-il été extrait quelque part sous le stockage privé de
     *      l'appli (peu importe le chemin exact utilisé par le plugin) ?
     *   2) Si oui, le main.js qu'on y trouve contient-il bien "Étape 1/5" (preuve que c'est la
     *      version qu'on vient de recompiler, pas une vieille copie figée) ?
     *   3) Les bibliothèques natives du moteur Node (libnode / libnodejs-mobile / cdvnodejsmobile)
     *      sont-elles présentes pour l'ABI réel de cet appareil ?
     */
    private JSONObject buildNodeDiagnostics() {
        JSONObject r = new JSONObject();
        try {
            r.put("supportedAbis", new JSONArray(android.os.Build.SUPPORTED_ABIS));

            // 1) Bibliothèques natives réellement installées pour CET appareil.
            JSONArray nativeLibs = new JSONArray();
            try {
                String nativeLibDir = context.getApplicationInfo().nativeLibraryDir;
                r.put("nativeLibraryDir", nativeLibDir);
                File dir = new File(nativeLibDir);
                File[] files = dir.listFiles();
                if (files != null) {
                    for (File f : files) nativeLibs.put(f.getName() + " (" + f.length() + " o)");
                }
            } catch (Exception e) {
                nativeLibs.put("Erreur de lecture : " + e.getMessage());
            }
            r.put("nativeLibs", nativeLibs);

            // 2) Recherche de main.js n'importe où sous le stockage privé de l'appli (filesDir),
            // sans supposer le chemin exact que nodejs-mobile-cordova utilise pour extraire ses
            // assets — ça évite de rater l'info si le plugin a changé de convention.
            JSONArray mainJsFound = new JSONArray();
            JSONArray topLevelFilesDir = new JSONArray();
            try {
                File filesDir = context.getFilesDir();
                File[] top = filesDir.listFiles();
                if (top != null) {
                    for (File f : top) {
                        topLevelFilesDir.put(f.getName() + (f.isDirectory() ? "/" : " (" + f.length() + " o)"));
                    }
                }
                findMainJsRecursive(filesDir, 0, 4, mainJsFound);
            } catch (Exception e) {
                mainJsFound.put("Erreur de recherche : " + e.getMessage());
            }
            r.put("topLevelFilesDir", topLevelFilesDir);
            r.put("mainJsFound", mainJsFound);

            // 3) Inspection ciblée de l'arbre node_modules réellement présent sur le disque du
            // TPE, précisément là où l'extraction est censée avoir eu lieu
            // (filesDir/www/nodejs-project/node_modules — voir NodeJS.java : PROJECT_ROOT =
            // "www/nodejs-project"). Sert à localiser exactement où l'arbre s'arrête quand un
            // require() échoue avec "Cannot find module" malgré une extraction réussie sans
            // exception : le dossier node_modules lui-même existe-t-il ? engine.io/ ? son
            // sous-dossier build/ ? le fichier engine.io.js exact, et avec quelle taille ?
            r.put("nodeModulesTree", inspectCriticalPaths(context.getFilesDir()));
        } catch (Exception e) {
            try { r.put("error", e.getMessage()); } catch (Exception ignored) {}
        }
        return r;
    }

    /**
     * Inspecte une liste de chemins précis, chacun relatif à filesDir, et rapporte pour chacun :
     * s'il existe, si c'est un dossier ou un fichier, sa taille (fichier) ou le nombre d'entrées
     * + un aperçu de ses 40 premiers noms (dossier). Permet de localiser précisément à quel
     * niveau de l'arborescence node_modules l'extraction s'arrête, sans avoir à deviner.
     */
    private JSONArray inspectCriticalPaths(File filesDir) {
        JSONArray out = new JSONArray();
        String[] relPaths = new String[]{
                "www/nodejs-project/node_modules",
                "www/nodejs-project/node_modules/engine.io",
                "www/nodejs-project/node_modules/engine.io/build",
                "www/nodejs-project/node_modules/engine.io/build/engine.io.js",
                "www/nodejs-project/node_modules/engine.io/package.json",
                "www/nodejs-project/node_modules/socket.io",
                "www/nodejs-project/node_modules/socket.io/package.json",
                "www/nodejs-project/node_modules/socket.io/dist/index.js"
        };
        for (String rel : relPaths) {
            JSONObject entry = new JSONObject();
            try {
                entry.put("path", rel);
                File f = new File(filesDir, rel);
                boolean exists = f.exists();
                entry.put("existe", exists);
                if (exists) {
                    entry.put("estDossier", f.isDirectory());
                    if (f.isDirectory()) {
                        String[] children = f.list();
                        entry.put("nbEntrees", children == null ? -1 : children.length);
                        JSONArray preview = new JSONArray();
                        if (children != null) {
                            java.util.Arrays.sort(children);
                            for (int i = 0; i < Math.min(children.length, 40); i++) preview.put(children[i]);
                        }
                        entry.put("apercu", preview);
                    } else {
                        entry.put("taille", f.length());
                    }
                }
            } catch (Exception e) {
                try { entry.put("erreur", e.getMessage()); } catch (Exception ignored) {}
            }
            out.put(entry);
        }
        return out;
    }

    private void findMainJsRecursive(File dir, int depth, int maxDepth, JSONArray out) {
        if (depth > maxDepth || out.length() > 10) return;
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File f : children) {
            if (out.length() > 10) return;
            if (f.isDirectory()) {
                findMainJsRecursive(f, depth + 1, maxDepth, out);
            } else if (f.getName().equals("main.js")) {
                try {
                    JSONObject entry = new JSONObject();
                    entry.put("path", f.getAbsolutePath());
                    entry.put("size", f.length());
                    entry.put("lastModified", f.lastModified());
                    byte[] data = new byte[(int) Math.min(f.length(), 300)];
                    try (java.io.FileInputStream fis = new java.io.FileInputStream(f)) {
                        fis.read(data);
                    }
                    String preview = new String(data, "UTF-8");
                    entry.put("preview", preview);
                    entry.put("estCodeRecent", preview.contains("Étape 1/5") || preview.contains("Etape 1/5"));
                    out.put(entry);
                } catch (Exception e) {
                    try {
                        JSONObject entry = new JSONObject();
                        entry.put("path", f.getAbsolutePath());
                        entry.put("error", e.getMessage());
                        out.put(entry);
                    } catch (Exception ignored) {}
                }
            }
        }
    }
}
