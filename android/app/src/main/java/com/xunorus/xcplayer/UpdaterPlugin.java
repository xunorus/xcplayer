package com.xunorus.xcplayer;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Auto-actualización de la app: baja el APK cifrado de GitHub Pages, lo descifra
 * (mismo formato que tools/encrypt-apk.js: "XCE1" + salt16 + iv12 + AES-256-GCM,
 * PBKDF2-SHA256 310000 iteraciones) y dispara el instalador de Android.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    private static final int PBKDF2_ITERATIONS = 310000;
    private final ExecutorService exec = Executors.newSingleThreadExecutor();

    private void emit(String phase, int pct) {
        JSObject ev = new JSObject();
        ev.put("phase", phase);
        ev.put("pct", pct);
        notifyListeners("updateProgress", ev);
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean ok = Build.VERSION.SDK_INT < 26
            || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 26) {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        final String url = call.getString("url");
        final String password = call.getString("password");
        if (url == null || password == null) {
            call.reject("url y password requeridos");
            return;
        }
        if (Build.VERSION.SDK_INT < 26) {
            call.reject("Android demasiado viejo para auto-actualizar");
            return;
        }
        exec.execute(() -> {
            File enc = new File(getContext().getCacheDir(), "update.enc");
            File apk = new File(getContext().getCacheDir(), "xcplayer-update.apk");
            try {
                // 1. descargar el .enc con progreso
                HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
                con.setConnectTimeout(15000);
                con.setReadTimeout(30000);
                long total = con.getContentLengthLong();
                try (InputStream in = con.getInputStream(); FileOutputStream out = new FileOutputStream(enc)) {
                    byte[] buf = new byte[65536];
                    long got = 0; int n; int lastPct = -1;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        got += n;
                        int pct = total > 0 ? (int) (got * 100 / total) : -1;
                        if (pct != lastPct) { emit("download", pct); lastPct = pct; }
                    }
                }
                con.disconnect();

                // 2. descifrar (streaming; si la pass es incorrecta, GCM falla al final)
                try (FileInputStream in = new FileInputStream(enc); FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] head = new byte[32];
                    if (in.read(head) != 32 || head[0] != 'X' || head[1] != 'C' || head[2] != 'E' || head[3] != '1')
                        throw new Exception("archivo cifrado inválido");
                    byte[] salt = Arrays.copyOfRange(head, 4, 20);
                    byte[] iv = Arrays.copyOfRange(head, 20, 32);
                    SecretKeyFactory f = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
                    byte[] key = f.generateSecret(
                        new PBEKeySpec(password.toCharArray(), salt, PBKDF2_ITERATIONS, 256)).getEncoded();
                    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                    c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
                    long encTotal = enc.length() - 32;
                    byte[] buf = new byte[65536];
                    long got = 0; int n; int lastPct = -1;
                    while ((n = in.read(buf)) > 0) {
                        byte[] plain = c.update(buf, 0, n);
                        if (plain != null && plain.length > 0) out.write(plain);
                        got += n;
                        int pct = (int) (got * 100 / encTotal);
                        if (pct != lastPct) { emit("decrypt", pct); lastPct = pct; }
                    }
                    byte[] tail = c.doFinal(); // acá explota si la contraseña está mal
                    if (tail != null && tail.length > 0) out.write(tail);
                }
                enc.delete();

                // 3. instalador de Android
                Uri uri = FileProvider.getUriForFile(getContext(),
                    getContext().getPackageName() + ".fileprovider", apk);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                call.resolve();
            } catch (AEADBadTagException e) {
                apk.delete(); enc.delete();
                call.reject("contraseña incorrecta");
            } catch (Exception e) {
                apk.delete(); enc.delete();
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        });
    }
}
