package com.fss.caisse.printer;

import android.content.Context;
import android.graphics.Bitmap;
import android.util.Log;

/**
 * Driver pour les TPE Senraise H10S / H10Se, toutes séries.
 *
 * *** À COMPLÉTER — ce driver est un squelette, pas encore fonctionnel. ***
 *
 * Contrairement à Sunmi, Senraise ne publie pas son SDK imprimante publiquement : leur fiche
 * produit mentionne "SDK gratuit sur demande" (support@senraise / leur commercial), fourni sous
 * forme de fichier .aar ou .jar après contact. Je n'ai pas pu vérifier le nom exact des classes
 * de ce SDK sans ce document — plutôt que d'inventer une API qui ne correspondrait pas au
 * vrai service embarqué (et qui planterait silencieusement en prod), ce driver reste un
 * stub explicite.
 *
 * Pour l'activer, une fois le SDK obtenu auprès de Senraise :
 *   1. Copier le .aar/.jar fourni dans android/app/libs/
 *      et l'ajouter aux dépendances de android/app/build.gradle :
 *          implementation files('libs/<nom-du-fichier>.aar')
 *   2. Suivre leur documentation pour ouvrir la connexion au service d'impression
 *      (généralement un bindService() vers un service AIDL embarqué, comme chez Sunmi,
 *      ou un SDK statique du type PrinterManager.getInstance(context)).
 *   3. Remplacer le contenu de bind(), isAvailable() et printBitmap() ci-dessous par les
 *      appels réels de leur SDK. La plupart des SDK de TPE génériques exposent une méthode
 *      du type printBitmap(Bitmap) ou printRasterBitmap(Bitmap) — proche de l'API Sunmi.
 *
 * Tant que ce fichier n'est pas complété, printBitmap() renvoie une erreur explicite au lieu
 * d'échouer silencieusement, pour que ce soit immédiatement visible en test.
 */
public class H10sPrinterDriver implements PrinterDriver {

    private static final String TAG = "FSS-H10sPrinter";

    public H10sPrinterDriver(Context context) {
        // TODO : initialiser la connexion au service d'impression du SDK Senraise ici.
    }

    @Override
    public String getName() {
        return "Senraise H10S (non implémenté — SDK fabricant requis)";
    }

    @Override
    public boolean isAvailable() {
        // TODO : retourner true une fois la connexion au SDK Senraise établie avec succès.
        return false;
    }

    @Override
    public void printBitmap(Bitmap bitmap, Callback callback) {
        String msg = "Impression H10S non implémentée : il manque le SDK imprimante propriétaire "
                + "de Senraise (à demander à leur support, gratuit selon leur fiche produit). "
                + "Voir les instructions dans H10sPrinterDriver.java.";
        Log.e(TAG, msg);
        callback.onError(msg);
    }
}
