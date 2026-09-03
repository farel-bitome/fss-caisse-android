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
                doPrint(args.optString("html", ""), callbackId);
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
    private void doPrint(String html, String callbackId) {
        PrinterDriver driver = PrinterDriverFactory.get(context);
        HtmlToBitmap.render(context, html, 384, new HtmlToBitmap.Callback() {
            @Override
            public void onBitmap(Bitmap bitmap) {
                driver.printBitmap(bitmap, new PrinterDriver.Callback() {
                    @Override
                    public void onSuccess() { respond(callbackId, ok()); }

                    @Override
                    public void onError(String message) {
                        Log.e(TAG, "Impression échouée (" + driver.getName() + ") : " + message);
                        respond(callbackId, error(message));
                    }
                });
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
}
