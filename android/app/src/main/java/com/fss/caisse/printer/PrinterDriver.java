package com.fss.caisse.printer;

import android.graphics.Bitmap;

/**
 * Contrat commun à tous les drivers d'imprimante interne de TPE.
 *
 * Chaque fabricant de TPE Android (Sunmi, Senraise/H10S, PAX, iMin...) fournit son propre SDK
 * propriétaire pour piloter l'imprimante thermique intégrée. Cette interface isole le reste de
 * l'application de ces différences : le pont JS (FssNativeBridge) ne connaît que "imprimer ce
 * bitmap", jamais les détails AIDL/SDK d'un fabricant particulier.
 *
 * Pour ajouter un nouveau modèle de TPE : créer une classe qui implémente cette interface,
 * puis l'enregistrer dans PrinterDriverFactory.
 */
public interface PrinterDriver {

    interface Callback {
        void onSuccess();
        void onError(String message);
    }

    /** Nom lisible du driver (pour les logs/diagnostics affichés à l'utilisateur). */
    String getName();

    /**
     * Vérifie que le service d'impression du fabricant est disponible sur cet appareil
     * (ex : service AIDL lié avec succès). Doit être rapide et ne jamais bloquer longtemps.
     */
    boolean isAvailable();

    /**
     * Imprime le bitmap fourni (rendu du ticket HTML) puis avance le papier.
     * Doit être appelé depuis un thread de fond — jamais le thread UI.
     */
    void printBitmap(Bitmap bitmap, Callback callback);
}
