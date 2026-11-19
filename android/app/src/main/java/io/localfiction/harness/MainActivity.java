package io.localfiction.harness;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String HAS_WEB_OVERLAY_SCRIPT =
        "(function(){" +
        "var state=history.state;" +
        "return !!(state&&typeof state==='object'&&" +
        "typeof state.lfhOverlaySession==='string'&&" +
        "Number(state.lfhOverlayDepth)===state.lfhOverlayDepth&&" +
        "state.lfhOverlayDepth>0);" +
        "})()";
    private static final long BACK_NAVIGATION_GUARD_MS = 300;

    private boolean backNavigationInFlight = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeSsePlugin.class);
        registerPlugin(NativeBinaryPlugin.class);
        registerPlugin(NativeVaultPlugin.class);
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge().getWebView();
                if (webView == null) {
                    finish();
                    return;
                }
                if (backNavigationInFlight) return;

                backNavigationInFlight = true;
                webView.evaluateJavascript(HAS_WEB_OVERLAY_SCRIPT, result ->
                    runOnUiThread(() -> {
                        if ("true".equals(result)) {
                            webView.evaluateJavascript("history.back()", ignored ->
                                runOnUiThread(() ->
                                    webView.postDelayed(
                                        () -> backNavigationInFlight = false,
                                        BACK_NAVIGATION_GUARD_MS
                                    )
                                )
                            );
                            return;
                        }
                        if (webView.canGoBack()) {
                            webView.goBack();
                            webView.postDelayed(
                                () -> backNavigationInFlight = false,
                                BACK_NAVIGATION_GUARD_MS
                            );
                            return;
                        }
                        backNavigationInFlight = false;
                        finish();
                    })
                );
            }
        });
    }
}
