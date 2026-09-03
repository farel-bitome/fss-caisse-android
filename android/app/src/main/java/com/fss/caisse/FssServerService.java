package com.fss.caisse;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Service au premier plan (foreground service) démarré en mode autonome (rôle "server").
 *
 * Sans ça, Android peut librement tuer le processus de l'appli — et donc le thread Node.js
 * embarqué qui sert le TPE — dès que l'écran s'éteint ou que l'appli passe en arrière-plan
 * (changement d'appli, mise en veille du terminal...). Un foreground service avec notification
 * persistante indique au système que l'appli rend un service actif à l'utilisateur, ce qui
 * réduit très fortement le risque d'être tué pour libérer de la mémoire.
 *
 * Ce service ne fait rien d'autre que se maintenir en vie : le vrai travail (serveur HTTP,
 * Socket.io...) tourne dans le thread nodejs-mobile démarré par android-bridge.js. Voir
 * FssNativeBridge#startServerService / stopServerService pour son cycle de vie, calé sur le
 * choix du rôle "autonome".
 */
public class FssServerService extends Service {

    private static final String CHANNEL_ID = "fss_caisse_server";
    private static final int NOTIFICATION_ID = 1;

    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, buildNotification());

        // Empêche le CPU de s'endormir complètement pendant que le serveur écoute — sans quoi
        // les autres postes (clients Android/PC) pourraient voir des requêtes traîner ou
        // échouer quand l'écran du TPE serveur est éteint.
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FssCaisse:ServerWakeLock");
                wakeLock.setReferenceCounted(false);
            }
        }
        if (wakeLock != null && !wakeLock.isHeld()) {
            wakeLock.acquire();
        }

        // START_STICKY : si Android tue quand même le service (mémoire très basse), il tente
        // de le relancer automatiquement dès que possible.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "FSS-CAISSE — Serveur",
                    NotificationManager.IMPORTANCE_LOW // silencieux, pas de son/vibration
            );
            channel.setDescription("Indique que le serveur de caisse embarqué est actif sur ce TPE.");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        Intent openApp = new Intent(this, MainActivity.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, openApp, flags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("FSS-CAISSE TPE")
                .setContentText("Serveur de caisse actif sur cet appareil")
                .setSmallIcon(android.R.drawable.ic_menu_manage)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }
}
