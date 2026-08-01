package com.xunorus.xcplayer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.IBinder;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.media.session.MediaButtonReceiver;

/**
 * Servicio foreground que sostiene la notificación de reproducción (MediaStyle).
 * No reproduce nada: el audio vive en el WebView. Existe para que Android muestre
 * los controles en el panel de notificaciones / pantalla de bloqueo / Bluetooth y
 * para que el proceso no lo mate el sistema mientras suena música en segundo plano.
 */
public class PlayerService extends Service {

    private static final String CHANNEL_ID = "xcplayer-playback";
    private static final int NOTIF_ID = 42;

    static void start(Context ctx) {
        Intent i = new Intent(ctx, PlayerService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception ignored) {
            // Android 12+ puede rechazar arrancar un FGS desde background; no vale la pena crashear
        }
    }

    static void stop(Context ctx) {
        try { ctx.stopService(new Intent(ctx, PlayerService.class)); } catch (Exception ignored) {}
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        MediaSessionCompat session = MediaSessionPlugin.getSession();
        if (session == null) {
            // startForegroundService exige un startForeground aunque sea para morir enseguida
            safeStartForeground(placeholder());
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        // botones de la notificación y teclas de Bluetooth/auriculares
        MediaButtonReceiver.handleIntent(session, intent);

        PlaybackStateCompat st = session.getController().getPlaybackState();
        boolean playing = st != null && st.getState() == PlaybackStateCompat.STATE_PLAYING;

        Notification n = build(session, playing);
        safeStartForeground(n);
        if (!playing) {
            // pausado: que se pueda descartar deslizando, pero el servicio sigue vivo
            stopForeground(Service.STOP_FOREGROUND_DETACH);
            try {
                NotificationManagerCompat.from(this).notify(NOTIF_ID, n);
            } catch (SecurityException ignored) {
                // sin permiso POST_NOTIFICATIONS (Android 13+)
            }
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        stopForeground(true);
        NotificationManagerCompat.from(this).cancel(NOTIF_ID);
        super.onDestroy();
    }

    /* ---------------- notificación ---------------- */

    private void safeStartForeground(Notification n) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Exception ignored) {}
    }

    private NotificationCompat.Builder baseBuilder() {
        createChannel();
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_media_music)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setSilent(true)
            .setShowWhen(false);
    }

    private Notification placeholder() {
        return baseBuilder().setContentTitle("XC Player").build();
    }

    private Notification build(MediaSessionCompat session, boolean playing) {
        MediaMetadataCompat md = session.getController().getMetadata();
        String title = md != null ? md.getString(MediaMetadataCompat.METADATA_KEY_TITLE) : null;
        String artist = md != null ? md.getString(MediaMetadataCompat.METADATA_KEY_ARTIST) : null;

        Intent open = new Intent(this, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT
            | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, piFlags);
        PendingIntent stopIntent = MediaButtonReceiver.buildMediaButtonPendingIntent(
            this, PlaybackStateCompat.ACTION_STOP);

        NotificationCompat.Builder b = baseBuilder()
            .setContentTitle(title != null ? title : "XC Player")
            .setContentText(artist != null ? artist : "")
            .setLargeIcon(BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher))
            .setContentIntent(content)
            .setDeleteIntent(stopIntent)
            .setOngoing(playing)
            .addAction(new NotificationCompat.Action(R.drawable.ic_media_prev, "Anterior",
                MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS)))
            .addAction(playing
                ? new NotificationCompat.Action(R.drawable.ic_media_pause, "Pausa",
                    MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_PLAY_PAUSE))
                : new NotificationCompat.Action(R.drawable.ic_media_play, "Reproducir",
                    MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_PLAY_PAUSE)))
            .addAction(new NotificationCompat.Action(R.drawable.ic_media_next, "Siguiente",
                MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_SKIP_TO_NEXT)))
            .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2)
                .setShowCancelButton(true)
                .setCancelButtonIntent(stopIntent));

        return b.build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Reproducción",
            NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Controles de la música en curso");
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.enableVibration(false);
        nm.createNotificationChannel(ch);
    }
}
