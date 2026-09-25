package com.fss.caisse.printer;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.util.Log;

import java.util.List;

/**
 * Détection "universelle" de l'imprimante thermique intégrée.
 *
 * Plutôt que de se fier uniquement au nom du fabricant déclaré (Build.MANUFACTURER/BRAND), qui
 * est peu fiable sur les nombreuses caisses/tablettes/TPE "en marque blanche" construites sur les
 * mêmes plateformes matérielles chinoises, on interroge directement le gestionnaire de paquets
 * pour voir quel SERVICE d'impression est réellement installé sur cet appareil précis :
 *   1. Service Sunmi (woyou.aidlservice.jiuiv5) — présent sur tous les Sunmi (V1/V1s, V2/V2 Pro/
 *      V2s, V3, P1/P1 4G, T1/T2/T2 mini/T2s, D2, S2...) ET sur beaucoup de clones/OEM qui
 *      embarquent le même service pour rester compatibles avec les applications déjà écrites
 *      pour Sunmi.
 *   2. Service Senraise (recieptservice.com.recieptservice) — présent sur les H10, H10C, H10S,
 *      H10P et leurs variantes OEM.
 *   3. Si ni l'un ni l'autre n'est trouvé : secours universel via le cadre d'impression standard
 *      Android (AndroidSystemPrinterDriver), qui fonctionne sur N'IMPORTE QUEL appareil Android,
 *      caisse enregistreuse, tablette ou TPE — avec ou sans SDK propriétaire.
 *
 * Ce choix est fait une fois par appareil (mis en cache), mais reste réévaluable : voir
 * FssNativeBridge.doPrint(), qui bascule automatiquement sur le secours universel si le driver
 * choisi ici s'avère finalement indisponible au moment d'imprimer (ex : service détecté installé
 * mais jamais réellement lié avec succès).
 */
public class PrinterDriverFactory {

    private static final String TAG = "FSS-PrinterFactory";

    private static final String SUNMI_PACKAGE = "woyou.aidlservice.jiuiv5";
    private static final String SUNMI_ACTION = "woyou.aidlservice.jiuiv5.IWoyouService";
    private static final String SENRAISE_PACKAGE = "recieptservice.com.recieptservice";
    private static final String SENRAISE_CLASS = "recieptservice.com.recieptservice.service.PrinterService";

    private static PrinterDriver instance;
    private static AndroidSystemPrinterDriver universalFallback;

    public static synchronized PrinterDriver get(Context context) {
        if (instance == null) {
            // Détection primaire : le service réellement installé (voir le commentaire de classe).
            // Complétée par le nom du fabricant/modèle (même logique que FSS-CALCUL) comme SIGNAL
            // SUPPLÉMENTAIRE dans les logs et pour choisir en priorité SUNMI si les deux signaux se
            // contredisent — utile sur un appareil où le service est présent mais pas encore
            // interrogeable (juste après un flash/reset d'usine, par exemple).
            boolean sunmiParFabricant = isSunmiParFabricant();
            boolean senraiseParFabricant = isSenraiseParFabricant();
            if (isServiceInstalled(context, SUNMI_PACKAGE, SUNMI_ACTION) || sunmiParFabricant) {
                Log.i(TAG, "Imprimante Sunmi détectée (" + Build.MANUFACTURER + "/" + Build.BRAND + "/" + Build.MODEL + ") — driver Sunmi sélectionné.");
                instance = new SunmiPrinterDriver(context);
            } else if (isServiceInstalled(context, SENRAISE_PACKAGE, null) || senraiseParFabricant) {
                Log.i(TAG, "Imprimante Senraise détectée (" + Build.MANUFACTURER + "/" + Build.BRAND + "/" + Build.MODEL + ") — driver Senraise sélectionné.");
                instance = new H10sPrinterDriver(context);
            } else {
                Log.i(TAG, "Aucun service imprimante fabricant reconnu sur " + Build.MANUFACTURER + "/" + Build.MODEL
                        + " — secours universel (impression système Android).");
                instance = universalFallback(context);
            }
        }
        return instance;
    }

    /** Même logique de détection par fabricant que FSS-CALCUL (Build.MANUFACTURER/BRAND). */
    private static boolean isSunmiParFabricant() {
        return Build.MANUFACTURER.toUpperCase().contains("SUNMI") || Build.BRAND.toUpperCase().contains("SUNMI");
    }

    /** Même logique de détection par fabricant/modèle que FSS-CALCUL : H10, H10C, H10S, H10P. */
    private static boolean isSenraiseParFabricant() {
        return Build.MANUFACTURER.toUpperCase().contains("SENRAISE")
                || Build.BRAND.toUpperCase().contains("SENRAISE")
                || Build.MODEL.toUpperCase().startsWith("H10");
    }

    /** Le secours universel, toujours disponible, y compris quand un autre driver a été choisi ci-dessus. */
    public static synchronized PrinterDriver universalFallback(Context context) {
        if (universalFallback == null) {
            universalFallback = new AndroidSystemPrinterDriver(context);
        }
        return universalFallback;
    }

    /**
     * Vérifie si le service d'un fabricant est réellement installé sur CET appareil (pas
     * seulement "probablement présent d'après le nom du fabricant"). Utilise le
     * PackageManager plutôt qu'un simple essai de bindService(), qui ne dirait pas si l'échec
     * vient d'un paquet absent ou d'un problème temporaire de liaison.
     */
    private static boolean isServiceInstalled(Context context, String packageName, String action) {
        try {
            PackageManager pm = context.getPackageManager();
            // Vérifie d'abord que le paquet lui-même est installé — le moyen le plus direct et
            // le plus fiable, indépendant du nom exact de l'action AIDL.
            try {
                pm.getPackageInfo(packageName, 0);
                return true;
            } catch (PackageManager.NameNotFoundException notFound) {
                // Le paquet n'apparaît pas directement — certains fabricants déclarent le
                // service sans que getPackageInfo() le retrouve selon la version d'Android ;
                // on retente via une résolution d'intent explicite sur l'action connue.
                if (action == null) return false;
                Intent probe = new Intent(action);
                probe.setPackage(packageName);
                List<ResolveInfo> matches = pm.queryIntentServices(probe, 0);
                return matches != null && !matches.isEmpty();
            }
        } catch (Exception e) {
            Log.w(TAG, "Erreur lors de la détection du service " + packageName + " : " + e.getMessage());
            return false;
        }
    }

    private PrinterDriverFactory() {}
}
