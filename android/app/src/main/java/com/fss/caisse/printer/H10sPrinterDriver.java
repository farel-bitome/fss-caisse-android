package com.fss.caisse.printer;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.graphics.Bitmap;
import android.os.IBinder;
import android.os.RemoteException;
import android.util.Log;

import recieptservice.com.recieptservice.PrinterInterface;

/**
 * Driver pour les TPE Senraise H10 / H10C / H10S / H10P, toutes séries.
 *
 * Utilise le service d'impression embarqué "recieptservice.com.recieptservice" (interface
 * AIDL PrinterInterface — source communautaire, licence BSD-3), le même mécanisme que celui déjà
 * validé dans FSS-CALCUL (autre projet du même éditeur, aussi destiné aux TPE Senraise H10/H10S).
 * Même schéma que SunmiPrinterDriver : liaison persistante au service dès la création du driver,
 * avec reconnexion automatique en cas de coupure, plutôt qu'une liaison à la demande à chaque
 * impression — cohérent avec FssServerService qui tourne en continu en mode autonome.
 *
 * Le H10S et le H10P ont une imprimante thermique 58 mm intégrée. Pour un H10 "de base" sans
 * imprimante, ou un firmware OEM personnalisé exposant une API différente, isAvailable() renvoie
 * simplement false et PrinterDriverFactory retombe sur l'impression système Android.
 */
public class H10sPrinterDriver implements PrinterDriver {

    private static final String TAG = "FSS-H10sPrinter";
    private static final String SERVICE_PACKAGE = "recieptservice.com.recieptservice";
    private static final String SERVICE_CLASS = "recieptservice.com.recieptservice.service.PrinterService";

    private final Context context;
    private PrinterInterface service;
    private boolean bound = false;

    public H10sPrinterDriver(Context context) {
        this.context = context.getApplicationContext();
        bind();
    }

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            service = PrinterInterface.Stub.asInterface(binder);
            bound = (service != null);
            Log.i(TAG, "Service imprimante Senraise connecté.");
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            service = null;
            bound = false;
            Log.w(TAG, "Service imprimante Senraise déconnecté — tentative de reconnexion automatique.");
            bind();
        }
    };

    private void bind() {
        try {
            Intent intent = new Intent();
            intent.setClassName(SERVICE_PACKAGE, SERVICE_CLASS);
            boolean started = context.bindService(intent, connection, Context.BIND_AUTO_CREATE);
            if (!started) {
                Log.w(TAG, "bindService() a échoué immédiatement — service Senraise absent sur cet appareil.");
            }
        } catch (Exception e) {
            Log.e(TAG, "Impossible de lier le service imprimante Senraise : " + e.getMessage());
        }
    }

    @Override
    public String getName() {
        return "Senraise H10/H10C/H10S/H10P (service recieptservice)";
    }

    @Override
    public boolean isAvailable() {
        return bound && service != null;
    }

    @Override
    public int getMaxWidthPx() {
        // Le H10S/H10P n'a qu'un module thermique 58mm intégré (384px à 203dpi) — voir le
        // commentaire de classe et celui de l'interface PrinterDriver.getMaxWidthPx(). Un bon de
        // commande ou un ticket automatique, générés par défaut en 80mm (576px), doivent donc être
        // réduits AVANT le rendu, sinon rien ne sort de l'imprimante sur ce modèle.
        return 384;
    }

    // Voir le commentaire équivalent dans SunmiPrinterDriver : au-delà d'environ 1 Mo, une
    // transaction Binder/AIDL peut échouer silencieusement selon le firmware — un ticket un peu
    // long en ARGB_8888 dépasse vite ce seuil. Le service Senraise n'ayant pas de callback
    // asynchrone par appel (contrairement à Sunmi), on découpe simplement en boucle synchrone.
    private static final int MAX_SLICE_BYTES = 256 * 1024;

    // Contrairement à Sunmi (dont le SDK ne redonne la main, via onRunResult, qu'une fois CHAQUE
    // tranche réellement imprimée — un rythme naturellement calé sur la vitesse physique de la
    // tête d'impression), l'appel service.printBitmap() ici ne fait qu'empiler la tranche dans une
    // file d'attente et rend la main immédiatement. Pour un ticket court (bon de commande, reçu,
    // prélèvement — quelques tranches), ça ne pose pas de problème. Mais le bilan de clôture peut
    // contenir des dizaines de tranches (une ligne par transaction + par article de la journée) :
    // les envoyer en boucle serrée, sans aucune pause, peut saturer le tampon interne du module
    // thermique 58mm — la fin du ticket est alors silencieusement perdue (aucune exception, aucune
    // erreur renvoyée), exactement le symptôme observé uniquement sur ce ticket, le plus long de
    // tous. On laisse donc au module le temps physique d'imprimer chaque tranche avant d'envoyer
    // la suivante, avec une pause proportionnelle à sa hauteur (à 203dpi, une tête thermique 58mm
    // imprime grossièrement 50 à 70 mm/s ; on prend une marge de sécurité généreuse).
    private static final double PACING_MS_PER_PX = 3.0;
    private static final int PACING_MIN_MS = 60;
    private static final int PACING_MAX_MS = 500;

    @Override
    public void printBitmap(Bitmap bitmap, final Callback callback) {
        if (!isAvailable()) {
            callback.onError("Service imprimante Senraise non disponible (non lié ou appareil non Senraise H10).");
            return;
        }
        int width = Math.max(1, bitmap.getWidth());
        int bytesPerRow = width * 4; // ARGB_8888
        int sliceHeight = Math.max(1, MAX_SLICE_BYTES / bytesPerRow);
        int totalHeight = bitmap.getHeight();
        try {
            // Alignement centré (1), comme pour Sunmi — cohérent avec le rendu HTML déjà centré.
            service.setAlignment(1);
            for (int y = 0; y < totalHeight; y += sliceHeight) {
                int height = Math.min(sliceHeight, totalHeight - y);
                Bitmap slice = Bitmap.createBitmap(bitmap, 0, y, bitmap.getWidth(), height);
                try {
                    service.printBitmap(slice);
                } finally {
                    slice.recycle();
                }
                boolean derniereTranche = (y + height) >= totalHeight;
                if (!derniereTranche) {
                    long pauseMs = Math.max(PACING_MIN_MS,
                            Math.min(PACING_MAX_MS, Math.round(height * PACING_MS_PER_PX)));
                    try {
                        Thread.sleep(pauseMs);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
            service.nextLine(4);
            callback.onSuccess();
        } catch (RemoteException e) {
            callback.onError("Erreur de communication avec le service imprimante Senraise : " + e.getMessage());
        } catch (Exception e) {
            callback.onError("Erreur imprimante Senraise : " + e.getMessage());
        }
    }
}
