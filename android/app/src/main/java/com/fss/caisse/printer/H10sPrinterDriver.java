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
    public void printBitmap(Bitmap bitmap, final Callback callback) {
        if (!isAvailable()) {
            callback.onError("Service imprimante Senraise non disponible (non lié ou appareil non Senraise H10).");
            return;
        }
        try {
            // Alignement centré (1), comme pour Sunmi — cohérent avec le rendu HTML déjà centré.
            service.setAlignment(1);
            service.printBitmap(bitmap);
            service.nextLine(4);
            callback.onSuccess();
        } catch (RemoteException e) {
            callback.onError("Erreur de communication avec le service imprimante Senraise : " + e.getMessage());
        } catch (Exception e) {
            callback.onError("Erreur imprimante Senraise : " + e.getMessage());
        }
    }
}
