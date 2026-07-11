package com.xunorus.xcplayer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;

import java.io.File;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import kotlin.Unit;
import kotlin.jvm.functions.Function3;

@CapacitorPlugin(name = "YtDlp")
public class YtDlpPlugin extends Plugin {

    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private volatile boolean ready = false;

    private File musicDir() {
        File d = new File(getContext().getFilesDir(), "music");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private synchronized void ensureInit() throws Exception {
        if (ready) return;
        YoutubeDL.getInstance().init(getContext());
        FFmpeg.getInstance().init(getContext());
        ready = true;
    }

    private void emitLine(String line, float progress) {
        JSObject ev = new JSObject();
        ev.put("line", line);
        ev.put("progress", progress);
        notifyListeners("progress", ev);
    }

    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url requerida");
            return;
        }
        exec.execute(() -> {
            try {
                if (!ready) emitLine("inicializando yt-dlp…", -1);
                ensureInit();
                File dir = musicDir();
                Set<String> before = new HashSet<>();
                File[] existing = dir.listFiles();
                if (existing != null) for (File f : existing) before.add(f.getName());

                YoutubeDLRequest req = new YoutubeDLRequest(url);
                req.addOption("--extract-audio");
                req.addOption("--audio-format", "mp3");
                req.addOption("-o", dir.getAbsolutePath() + "/%(title)s.%(ext)s");
                req.addOption("--no-mtime");

                // args extra crudos de yt-dlp desde JS, p.ej. ["--extractor-args","youtube:player_client=..."]
                JSArray extra = call.getArray("args");
                if (extra != null) {
                    for (int i = 0; i < extra.length(); i++) {
                        String a = extra.getString(i);
                        String next = (i + 1 < extra.length()) ? extra.getString(i + 1) : null;
                        if (a.startsWith("-") && next != null && !next.startsWith("-")) {
                            req.addOption(a, next);
                            i++;
                        } else {
                            req.addOption(a);
                        }
                    }
                }

                Function3<Float, Long, String, Unit> cb = (progress, eta, line) -> {
                    emitLine(line, progress);
                    return Unit.INSTANCE;
                };
                YoutubeDL.getInstance().execute(req, null, cb);

                JSArray files = new JSArray();
                File[] after = dir.listFiles();
                if (after != null) for (File f : after) {
                    if (f.getName().toLowerCase().endsWith(".mp3") && !before.contains(f.getName())) {
                        JSObject o = new JSObject();
                        o.put("name", f.getName());
                        o.put("path", f.getAbsolutePath());
                        o.put("size", f.length());
                        files.put(o);
                    }
                }
                JSObject ret = new JSObject();
                ret.put("files", files);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        });
    }

    @PluginMethod
    public void update(PluginCall call) {
        exec.execute(() -> {
            try {
                ensureInit();
                YoutubeDL.UpdateStatus st =
                    YoutubeDL.getInstance().updateYoutubeDL(getContext(), YoutubeDL.UpdateChannel.STABLE.INSTANCE);
                String v = YoutubeDL.getInstance().version(getContext());
                JSObject ret = new JSObject();
                ret.put("status", String.valueOf(st));
                ret.put("version", v);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        });
    }

    @PluginMethod
    public void version(PluginCall call) {
        exec.execute(() -> {
            try {
                ensureInit();
                JSObject ret = new JSObject();
                ret.put("version", YoutubeDL.getInstance().version(getContext()));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        });
    }

    @PluginMethod
    public void removeFile(PluginCall call) {
        String p = call.getString("path");
        if (p != null) {
            File f = new File(p);
            // solo dentro de nuestra carpeta de música
            if (f.getAbsolutePath().startsWith(musicDir().getAbsolutePath())) f.delete();
        }
        call.resolve();
    }
}
