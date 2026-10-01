package com.xunorus.xcplayer;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private OnBackPressedCallback backCallback;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(YtDlpPlugin.class);
        registerPlugin(UpdaterPlugin.class);
        registerPlugin(MediaSessionPlugin.class);
        super.onCreate(savedInstanceState);
        // también en release: app personal, permite inspeccionar por adb/CDP
        WebView.setWebContentsDebuggingEnabled(true);

        // Capacitor no reenvía el botón atrás al WebView, así que sin esto un
        // "atrás" con un diálogo abierto cerraba la app entera. Le preguntamos
        // al JS si tiene algo que cerrar (window.xcBack) y sólo si dice que no
        // dejamos pasar el comportamiento normal de Android.
        backCallback = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = getBridge() != null ? getBridge().getWebView() : null;
                if (wv == null) {
                    passThrough();
                    return;
                }
                wv.evaluateJavascript(
                    "(function(){try{return !!(window.xcBack && window.xcBack())}catch(e){return false}})()",
                    value -> { if (!"true".equals(value)) passThrough(); }
                );
            }

            private void passThrough() {
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        };
        getOnBackPressedDispatcher().addCallback(this, backCallback);
    }
}
