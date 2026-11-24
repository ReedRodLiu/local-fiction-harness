package io.localfiction.harness;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int BACK_MODE_ORDINARY = 0;
    private static final int BACK_MODE_OVERLAY = 1;
    private static final int BACK_MODE_STALE_OVERLAY = 2;
    private static final String HANDLE_WEB_BACK_SCRIPT =
        "(function(){" +
        "var currentSession=window.__lfhOverlayHistorySession;" +
        "var state=history.state;" +
        "var hasOverlayState=!!(state&&typeof state==='object'&&" +
        "typeof state.lfhOverlaySession==='string');" +
        "var depth=hasOverlayState?Number(state.lfhOverlayDepth):0;" +
        "if(hasOverlayState&&typeof currentSession==='string'&&" +
        "state.lfhOverlaySession===currentSession&&" +
        "Number.isInteger(depth)&&depth>0){" +
        "history.back();return " + BACK_MODE_OVERLAY + ";" +
        "}" +
        "if(hasOverlayState)return " + BACK_MODE_STALE_OVERLAY + ";" +
        "return " + BACK_MODE_ORDINARY + ";" +
        "})()";
    private static final long BACK_NAVIGATION_GUARD_MS = 300;

    private boolean backNavigationInFlight = false;
    private long exitFlushSeq = 0;
    private ExitFlushCoordinator activeExitFlushCoordinator = null;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeSsePlugin.class);
        registerPlugin(NativeBinaryPlugin.class);
        registerPlugin(NativeVaultPlugin.class);
        registerPlugin(NativeUpdaterPlugin.class);
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
                webView.evaluateJavascript(HANDLE_WEB_BACK_SCRIPT, result ->
                    runOnUiThread(() -> {
                        if (webView != getBridge().getWebView()) {
                            backNavigationInFlight = false;
                            return;
                        }
                        int mode = parseBackMode(result);
                        if (mode == BACK_MODE_OVERLAY) {
                            webView.postDelayed(
                                () -> backNavigationInFlight = false,
                                BACK_NAVIGATION_GUARD_MS
                            );
                            return;
                        }
                        if (mode == BACK_MODE_STALE_OVERLAY) {
                            finishAfterBestEffortFlush(webView);
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
                        finishAfterBestEffortFlush(webView);
                    })
                );
            }
        });
    }

    @Override
    public void onDestroy() {
        if (activeExitFlushCoordinator != null) {
            activeExitFlushCoordinator.cancel();
            activeExitFlushCoordinator = null;
        }
        super.onDestroy();
    }

    private void finishAfterBestEffortFlush(WebView webView) {
        if (activeExitFlushCoordinator != null) {
            activeExitFlushCoordinator.cancel();
            activeExitFlushCoordinator = null;
        }
        if (isFinishing() || isDestroyed() || webView == null) {
            backNavigationInFlight = false;
            if (!isFinishing() && !isDestroyed()) finish();
            return;
        }
        ExitFlushCoordinator coordinator = new ExitFlushCoordinator(
            new ExitFlushCoordinator.Scheduler() {
                @Override
                public void postDelayed(Runnable action, long delayMs) {
                    webView.postDelayed(action, delayMs);
                }

                @Override
                public void removeCallbacks(Runnable action) {
                    webView.removeCallbacks(action);
                }
            },
            (script, callback) -> webView.evaluateJavascript(script, res ->
                runOnUiThread(() -> {
                    if (
                        isFinishing() ||
                        isDestroyed() ||
                        getBridge() == null ||
                        webView != getBridge().getWebView()
                    ) {
                        return;
                    }
                    callback.accept(res);
                })
            ),
            () -> {
                backNavigationInFlight = false;
                activeExitFlushCoordinator = null;
                if (!isFinishing() && !isDestroyed()) {
                    finish();
                }
            }
        );
        activeExitFlushCoordinator = coordinator;
        coordinator.flushAndFinish("exit-" + (++exitFlushSeq));
    }

    private static int parseBackMode(String result) {
        if (result == null) return BACK_MODE_ORDINARY;
        String value = result.replace("\"", "").trim();
        if ("1".equals(value)) return BACK_MODE_OVERLAY;
        if ("2".equals(value)) return BACK_MODE_STALE_OVERLAY;
        return BACK_MODE_ORDINARY;
    }
}
