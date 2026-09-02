package com.fss.caisse;

import android.content.Context;
import android.provider.Settings;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Date;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import org.json.JSONObject;

/**
 * Licence liée au matériel — portage Android de licensing.js (version bureau).
 *
 * IMPORTANT : le secret et l'algorithme (SHA-256 / HMAC-SHA256, formatage en 4 groupes de 4
 * caractères hexadécimaux) sont IDENTIQUES à la version bureau, pour qu'une clé produite par le
 * même générateur fonctionne sur les deux plateformes — seul l'identifiant machine change de
 * source (GUID Windows côté PC, ANDROID_ID côté TPE).
 *
 * *** HYPOTHÈSE À VÉRIFIER ***
 * Le commentaire de licensing.js (bureau) indique qu'un générateur de clé "Android" existe déjà
 * dans l'écosystème FSS-CAISSE-SALON. Je n'ai pas eu accès à son code : j'ai donc repris
 * l'identifiant Android le plus standard (Settings.Secure.ANDROID_ID) et préfixé la chaîne
 * hashée par "ANDROIDID|", en miroir du "WINGUID|" utilisé côté Windows. Si le générateur existant
 * utilise une autre convention, les clés ne correspondront pas tant que cette ligne (voir
 * getMachineId ci-dessous) n'est pas alignée dessus — c'est un changement d'une seule ligne.
 */
public class Licensing {

    // IMPORTANT : doit rester identique à LICENSE_SECRET dans licensing.js (bureau) et dans
    // tous les générateurs de licence existants.
    private static final String LICENSE_SECRET = "FSS-CAISSE-SALON-2026-FALLSERVICES-9f3a7c1e5b2d4681";
    private static final int TRIAL_DAYS = 3;

    private final File licenseFile;
    private final File trialFile;
    private final Context context;

    public Licensing(Context context) {
        this.context = context.getApplicationContext();
        this.licenseFile = new File(this.context.getFilesDir(), "license.json");
        this.trialFile = new File(this.context.getFilesDir(), "trial.json");
    }

    /** Identifiant stable de cet appareil Android, dérivé de ANDROID_ID (voir hypothèse ci-dessus). */
    public String getMachineId() {
        String androidId = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
        String raw = "ANDROIDID|" + (androidId == null ? "" : androidId);
        String hash = sha256Hex(raw).toUpperCase();
        return group4(hash.substring(0, 16));
    }

    private boolean isValidKey(String machineId, String key) {
        if (key == null || key.trim().isEmpty() || machineId == null) return false;
        String expected = hmacSha256Hex(LICENSE_SECRET, machineId).toUpperCase();
        String expectedFormatted = group4(expected.substring(0, 16));
        return key.trim().toUpperCase().equals(expectedFormatted);
    }

    public boolean isLicensed() {
        try {
            String raw = readFile(licenseFile);
            JSONObject data = new JSONObject(raw);
            return isValidKey(getMachineId(), data.optString("key", null));
        } catch (Exception e) {
            return false;
        }
    }

    /** @return JSONObject {success, error?} */
    public JSONObject activate(String key) {
        JSONObject result = new JSONObject();
        try {
            String machineId = getMachineId();
            if (!isValidKey(machineId, key)) {
                result.put("success", false);
                result.put("error", "Clé de licence invalide pour ce TPE.");
                return result;
            }
            JSONObject data = new JSONObject();
            data.put("key", key.trim().toUpperCase());
            data.put("machineId", machineId);
            data.put("activatedAt", new Date().toString());
            writeFile(licenseFile, data.toString(2));
            result.put("success", true);
            return result;
        } catch (Exception e) {
            try { result.put("success", false); result.put("error", e.getMessage()); } catch (Exception ignored) {}
            return result;
        }
    }

    /** @return JSONObject {daysLeft, expired} */
    public JSONObject getTrialStatus() {
        JSONObject r = new JSONObject();
        try {
            long firstLaunch;
            try {
                JSONObject data = new JSONObject(readFile(trialFile));
                firstLaunch = data.getLong("firstLaunch");
            } catch (Exception e) {
                firstLaunch = System.currentTimeMillis();
                JSONObject data = new JSONObject();
                data.put("firstLaunch", firstLaunch);
                writeFile(trialFile, data.toString());
            }
            long daysElapsed = (System.currentTimeMillis() - firstLaunch) / (1000L * 60 * 60 * 24);
            long daysLeft = Math.max(0, TRIAL_DAYS - daysElapsed);
            r.put("daysLeft", daysLeft);
            r.put("expired", daysElapsed >= TRIAL_DAYS);
        } catch (Exception e) {
            try { r.put("daysLeft", 0); r.put("expired", true); } catch (Exception ignored) {}
        }
        return r;
    }

    /** true si l'app doit être bloquée : essai terminé et pas de licence valide. */
    public boolean isBlocked() {
        try {
            return getTrialStatus().getBoolean("expired") && !isLicensed();
        } catch (Exception e) {
            return false;
        }
    }

    // ---------------------------------------------------------------------------------------
    private static String group4(String s16) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s16.length(); i += 4) {
            if (sb.length() > 0) sb.append('-');
            sb.append(s16, i, Math.min(i + 4, s16.length()));
        }
        return sb.toString();
    }

    private static String sha256Hex(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            return toHex(digest);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static String hmacSha256Hex(String secret, String input) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] digest = mac.doFinal(input.getBytes(StandardCharsets.UTF_8));
            return toHex(digest);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static String readFile(File f) throws Exception {
        byte[] data = new byte[(int) f.length()];
        try (java.io.FileInputStream fis = new java.io.FileInputStream(f)) {
            fis.read(data);
        }
        return new String(data, StandardCharsets.UTF_8);
    }

    private static void writeFile(File f, String content) throws Exception {
        try (FileOutputStream fos = new FileOutputStream(f)) {
            fos.write(content.getBytes(StandardCharsets.UTF_8));
        }
    }
}
