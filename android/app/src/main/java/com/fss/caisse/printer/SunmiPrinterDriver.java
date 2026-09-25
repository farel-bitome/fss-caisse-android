package com.fss.caisse.printer;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.graphics.Bitmap;
import android.os.IBinder;
import android.os.RemoteException;
import android.util.Log;

import woyou.aidlservice.jiuiv5.ICallback;
import woyou.aidlservice.jiuiv5.IWoyouService;

/**
 * Driver pour les TPE Sunmi (V2, V2 Pro, P2, T2...), toutes séries.
 *
 * Utilise le service AIDL officiel "woyou.aidlservice.jiuiv5" installé en usine sur tous les
 * appareils Sunmi équipés d'une imprimante intégrée. C'est le SDK public et documenté par Sunmi
 * (http://docs.sunmi.com) — aucune dépendance externe à télécharger, le service tourne déjà sur
 * l'appareil.
 */
public class SunmiPrinterDriver implements PrinterDriver {

    private static final String TAG = "FSS-SunmiPrinter";
    private static final String SERVICE_PACKAGE = "woyou.aidlservice.jiuiv5";
    private static final String SERVICE_ACTION = "woyou.aidlservice.jiuiv5.IWoyouService";

    private final Context context;
    private IWoyouService service;
    private boolean bound = false;

    public SunmiPrinterDriver(Context context) {
        this.context = context.getApplicationContext();
        bind();
    }

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            service = IWoyouService.Stub.asInterface(binder);
            bound = true;
            Log.i(TAG, "Service imprimante Sunmi connecté.");
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            service = null;
            bound = false;
            Log.w(TAG, "Service imprimante Sunmi déconnecté — tentative de reconnexion automatique.");
            bind();
        }
    };

    private void bind() {
        try {
            Intent intent = new Intent();
            intent.setPackage(SERVICE_PACKAGE);
            intent.setAction(SERVICE_ACTION);
            context.bindService(intent, connection, Context.BIND_AUTO_CREATE);
        } catch (Exception e) {
            Log.e(TAG, "Impossible de lier le service imprimante Sunmi : " + e.getMessage());
        }
    }

    @Override
    public String getName() {
        return "Sunmi (AIDL woyou.aidlservice.jiuiv5)";
    }

    @Override
    public boolean isAvailable() {
        return bound && service != null;
    }

    // Limite de sécurité pour chaque tranche envoyée via AIDL/Binder : Android limite la taille
    // totale d'une transaction Binder à environ 1 Mo (souvent moins en pratique une fois les
    // frais du framework comptés). Un ticket un peu long en ARGB_8888 (ex: 384x1500px = ~2,3 Mo)
    // dépasse largement cette limite, ce qui peut faire échouer l'appel SILENCIEUSEMENT sur
    // certains firmwares (le ticket sort blanc ou tronqué au lieu de renvoyer une vraie erreur).
    // On découpe donc le bitmap en tranches horizontales avant l'envoi, comme le font toutes les
    // applications de caisse sérieuses avec ce type de SDK.
    private static final int MAX_SLICE_BYTES = 256 * 1024;

    @Override
    public void printBitmap(Bitmap bitmap, final Callback callback) {
        if (!isAvailable()) {
            callback.onError("Service imprimante Sunmi non disponible (non lié ou appareil non Sunmi).");
            return;
        }
        int width = Math.max(1, bitmap.getWidth());
        int bytesPerRow = width * 4; // ARGB_8888
        int sliceHeight = Math.max(1, MAX_SLICE_BYTES / bytesPerRow);
        printSliceFrom(bitmap, 0, sliceHeight, callback);
    }

    private void printSliceFrom(final Bitmap bitmap, final int y, final int sliceHeight, final Callback callback) {
        int totalHeight = bitmap.getHeight();
        if (y >= totalHeight) {
            try {
                service.lineWrap(4, null);
            } catch (RemoteException ignored) {}
            callback.onSuccess();
            return;
        }
        int height = Math.min(sliceHeight, totalHeight - y);
        final Bitmap slice;
        try {
            slice = Bitmap.createBitmap(bitmap, 0, y, bitmap.getWidth(), height);
        } catch (Exception e) {
            callback.onError("Erreur de découpage du ticket avant impression : " + e.getMessage());
            return;
        }
        try {
            service.printBitmap(slice, new ICallback.Stub() {
                @Override
                public void onRunResult(boolean isSuccess) throws RemoteException {
                    try { slice.recycle(); } catch (Exception ignored) {}
                    if (isSuccess) {
                        printSliceFrom(bitmap, y + height, sliceHeight, callback);
                    } else {
                        callback.onError("L'imprimante Sunmi a signalé un échec (papier absent ?).");
                    }
                }

                @Override
                public void onReturnString(String result) throws RemoteException {
                    // Non utilisé pour l'impression bitmap.
                }

                @Override
                public void onRaiseException(int code, String msg) throws RemoteException {
                    try { slice.recycle(); } catch (Exception ignored) {}
                    callback.onError("Erreur imprimante Sunmi (" + code + ") : " + msg);
                }

                @Override
                public void onPrintResult(int code, String msg) throws RemoteException {
                    // Disponible sur les versions récentes du service ; non indispensable ici.
                }
            });
        } catch (RemoteException e) {
            try { slice.recycle(); } catch (Exception ignored) {}
            callback.onError("Erreur de communication avec le service imprimante Sunmi : " + e.getMessage());
        }
    }
}
