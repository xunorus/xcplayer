package com.xunorus.xcplayer;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.os.Build;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Controles de reproducción en el sistema (notificación, pantalla de bloqueo, Bluetooth).
 *
 * El audio lo sigue reproduciendo el <audio> del WebView — la MediaSession de la WebView
 * NO la publica Android (eso solo lo hace Chrome como navegador), así que acá se mantiene
 * una MediaSessionCompat nativa espejando el estado que manda app.js, y los botones del
 * sistema vuelven al JS como eventos "mediaAction".
 *
 * OJO: el foco de audio NO se toca acá. Chromium ya lo pide por el WebView
 * (org.chromium.content.browser.AudioFocusDelegate, usage=USAGE_MEDIA) y pausa solo ante
 * una llamada u otra app. Si el plugin también pedía foco, el pedido de Chromium le robaba
 * el foco al nuestro, el listener avisaba "pause" al JS y la canción se cortaba a los 0.4s.
 */
@CapacitorPlugin(
    name = "MediaSession",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class MediaSessionPlugin extends Plugin {

    private static MediaSessionCompat session;

    private boolean noisyRegistered = false;

    /** Lo usa PlayerService para armar la notificación. */
    static MediaSessionCompat getSession() {
        return session;
    }

    /* ---------------- eventos hacia el JS ---------------- */

    private void emit(String action, long positionMs) {
        JSObject ev = new JSObject();
        ev.put("action", action);
        if (positionMs >= 0) ev.put("position", positionMs / 1000.0);
        notifyListeners("mediaAction", ev);
    }

    /* ---------------- sesión ---------------- */

    private MediaSessionCompat ensureSession() {
        if (session != null) return session;
        MediaSessionCompat s = new MediaSessionCompat(getContext(), "XCPlayer");
        s.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { emit("play", -1); }
            @Override public void onPause() { emit("pause", -1); }
            @Override public void onSkipToNext() { emit("next", -1); }
            @Override public void onSkipToPrevious() { emit("prev", -1); }
            @Override public void onStop() { emit("stop", -1); }
            @Override public void onSeekTo(long pos) { emit("seek", pos); }
        });
        session = s;
        return s;
    }

    /* ---------------- métodos del plugin ---------------- */

    /** Android 13+ pide permiso explícito para mostrar notificaciones. */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve();
            return;
        }
        requestPermissionForAlias("notifications", call, "permCallback");
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        call.resolve();
    }

    /** Espeja el estado del <audio> del WebView: título, duración, posición y play/pause. */
    @PluginMethod
    public void update(PluginCall call) {
        final String title = call.getString("title", "XC Player");
        final String artist = call.getString("artist", "XC Player");
        final double duration = call.getDouble("duration", 0.0);
        final double position = call.getDouble("position", 0.0);
        final boolean isPlaying = Boolean.TRUE.equals(call.getBoolean("playing", false));

        getActivity().runOnUiThread(() -> {
            MediaSessionCompat s = ensureSession();
            s.setMetadata(new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, "XC Player")
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (long) (duration * 1000))
                .build());
            s.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY
                    | PlaybackStateCompat.ACTION_PAUSE
                    | PlaybackStateCompat.ACTION_PLAY_PAUSE
                    | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                    | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                    | PlaybackStateCompat.ACTION_SEEK_TO
                    | PlaybackStateCompat.ACTION_STOP)
                .setState(isPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                    (long) (position * 1000), isPlaying ? 1f : 0f)
                .build());
            s.setActive(true);

            if (isPlaying) registerNoisy(); else unregisterNoisy();
            PlayerService.start(getContext());
            call.resolve();
        });
    }

    /** Sin track cargado: saca la notificación y suelta el foco de audio. */
    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            teardown();
            call.resolve();
        });
    }

    private void teardown() {
        unregisterNoisy();
        if (session != null) {
            session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setState(PlaybackStateCompat.STATE_STOPPED, 0, 0f).build());
            session.setActive(false);
        }
        PlayerService.stop(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        teardown();
        if (session != null) {
            session.release();
            session = null;
        }
        super.handleOnDestroy();
    }

    /* ---------------- auriculares desconectados ---------------- */

    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            emit("pause", -1);
        }
    };

    private void registerNoisy() {
        if (noisyRegistered) return;
        ContextCompat.registerReceiver(getContext(), noisyReceiver,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED);
        noisyRegistered = true;
    }

    private void unregisterNoisy() {
        if (!noisyRegistered) return;
        try { getContext().unregisterReceiver(noisyReceiver); } catch (Exception ignored) {}
        noisyRegistered = false;
    }
}
