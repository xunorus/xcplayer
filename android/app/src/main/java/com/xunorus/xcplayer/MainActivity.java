package com.xunorus.xcplayer;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(YtDlpPlugin.class);
        registerPlugin(UpdaterPlugin.class);
        super.onCreate(savedInstanceState);
        // también en release: app personal, permite inspeccionar por adb/CDP
        WebView.setWebContentsDebuggingEnabled(true);
    }
}
