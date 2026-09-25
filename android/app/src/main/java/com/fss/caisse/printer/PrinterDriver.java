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
     * Largeur d'impression MAXIMALE (en pixels, 203dpi) que le module thermique de cet appareil
     * peut physiquement gérer, ou 0 si l'appareil accepte plusieurs formats (58mm ET 80mm — ex :
     * Sunmi V2 Pro) et qu'il n'y a donc rien à limiter.
     *
     * Certains TPE n'ont qu'un module 58mm intégré (ex : Senraise H10S/H10P — 384px). Envoyer à
     * leur service AIDL un bitmap plus large (ex : 576px pour du 80mm, utilisé par défaut pour les
     * bons de commande cuisine et les tickets automatiques) fait échouer l'impression — souvent
     * SILENCIEUSEMENT (rien ne sort, aucune erreur claire) plutôt qu'avec un message explicite.
     * FssNativeBridge utilise cette valeur pour réduire automatiquement la largeur demandée avant
     * même de générer le bitmap, quel que soit le format choisi côté JS.
     */
    default int getMaxWidthPx() { return 0; }

    /**
     * Imprime le bitmap fourni (rendu du ticket HTML) puis avance le papier.
     * Doit être appelé depuis un thread de fond — jamais le thread UI.
     */
    void printBitmap(Bitmap bitmap, Callback callback);
}
