package io.localfiction.harness;

import android.app.Activity;
import android.content.Context;
import android.os.PowerManager;
import android.util.Base64;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "NativeSse")
public class NativeSsePlugin extends Plugin {
    private static final String WAKE_LOCK_TAG = "Folio:NativeSseKeepalive";

    private final SseStreamClient streamClient = new SseStreamClient();
    private final SseEventBuffer eventBuffer = new SseEventBuffer();
    private final Object wakeLockGuard = new Object();
    private PowerManager.WakeLock wakeLock;

    private final SseKeepaliveCoordinator keepalive = new SseKeepaliveCoordinator(
        new SseKeepaliveCoordinator.Backend() {
            @Override
            public void startKeepalive(long wakeLockTimeoutMs) {
                acquireWakeLock(wakeLockTimeoutMs);
                Context context = getContext();
                if (context != null) {
                    SseForegroundService.startKeepalive(context);
                }
                updateKeepScreenOn(true);
            }

            @Override
            public void refreshWakeLock(long wakeLockTimeoutMs) {
                acquireWakeLock(wakeLockTimeoutMs);
            }

            @Override
            public void stopKeepalive() {
                try {
                    Context context = getContext();
                    if (context != null) {
                        SseForegroundService.stopKeepalive(context);
                    }
                    updateKeepScreenOn(false);
                } finally {
                    releaseWakeLock();
                }
            }
        }
    );

    @PluginMethod
    public void startStream(PluginCall call) {
        String requestId = call.getString("requestId");
        String url = call.getString("url");
        String body = call.getString("body", "");
        JSObject headersObj = call.getObject("headers");

        if (requestId == null || requestId.isEmpty() || url == null || url.isEmpty()) {
            call.reject("requestId and url are required.");
            return;
        }

        Map<String, String> headers = new HashMap<>();
        if (headersObj != null) {
            Iterator<String> keys = headersObj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String val = headersObj.getString(key);
                if (val != null) {
                    headers.put(key, val);
                }
            }
        }

        final boolean acquiredKeepalive = keepalive.onStreamStart(requestId);
        final AtomicBoolean keepaliveReleased = new AtomicBoolean(false);

        streamClient.startStream(requestId, url, headers, body, new SseStreamClient.Listener() {
            @Override
            public void onChunk(String reqId, byte[] chunk, int length) {
                String base64 = Base64.encodeToString(chunk, 0, length, Base64.NO_WRAP);
                eventBuffer.dispatchOrBuffer(
                    SseEventBuffer.SseEvent.chunk(reqId, base64),
                    NativeSsePlugin.this::dispatchEvent
                );
            }

            @Override
            public void onComplete(String reqId) {
                if (acquiredKeepalive && keepaliveReleased.compareAndSet(false, true)) {
                    keepalive.onStreamEnd(reqId);
                }
                eventBuffer.dispatchOrBuffer(
                    SseEventBuffer.SseEvent.complete(reqId),
                    NativeSsePlugin.this::dispatchEvent
                );
            }

            @Override
            public void onError(String reqId, int status, String message, boolean aborted) {
                onError(reqId, status, null, message, aborted);
            }

            @Override
            public void onError(String reqId, int status, String code, String message, boolean aborted) {
                if (acquiredKeepalive && keepaliveReleased.compareAndSet(false, true)) {
                    keepalive.onStreamEnd(reqId);
                }
                eventBuffer.dispatchOrBuffer(
                    SseEventBuffer.SseEvent.error(reqId, status, code, message, aborted),
                    NativeSsePlugin.this::dispatchEvent
                );
            }
        });

        call.resolve();
    }

    @PluginMethod
    public void abortStream(PluginCall call) {
        String requestId = call.getString("requestId");
        if (requestId != null && !requestId.isEmpty()) {
            keepalive.onStreamEnd(requestId);
            streamClient.abortStream(requestId);
            eventBuffer.clearRequest(requestId);
        }
        call.resolve();
    }

    @Override
    protected void handleOnPause() {
        eventBuffer.onPause();
        super.handleOnPause();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        eventBuffer.onResume(this::dispatchEvent);
    }

    @Override
    protected void handleOnDestroy() {
        try {
            streamClient.shutdown();
        } finally {
            eventBuffer.clearAll();
            keepalive.releaseAll();
        }
        super.handleOnDestroy();
    }

    private void dispatchEvent(SseEventBuffer.SseEvent event) {
        JSObject data = new JSObject();
        data.put("requestId", event.requestId);
        switch (event.type) {
            case CHUNK:
                data.put("chunkBase64", event.chunkBase64);
                notifyListeners("sseChunk", data);
                break;
            case COMPLETE:
                notifyListeners("sseComplete", data);
                break;
            case ERROR:
                data.put("message", event.message);
                if (event.code != null && !event.code.isEmpty()) {
                    data.put("code", event.code);
                }
                if (event.status > 0) {
                    data.put("status", event.status);
                }
                if (event.aborted) {
                    data.put("aborted", true);
                }
                notifyListeners("sseError", data);
                break;
        }
    }

    private void acquireWakeLock(long timeoutMs) {
        Context context = getContext();
        if (context == null) {
            return;
        }
        synchronized (wakeLockGuard) {
            try {
                if (wakeLock == null) {
                    PowerManager pm = (PowerManager) context
                        .getApplicationContext()
                        .getSystemService(Context.POWER_SERVICE);
                    if (pm == null) {
                        return;
                    }
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
                    wakeLock.setReferenceCounted(false);
                }
                wakeLock.acquire(timeoutMs);
            } catch (RuntimeException ignored) {
                // Keep streaming alive even if OEM power policy restricts wake locks.
            }
        }
    }

    private void releaseWakeLock() {
        synchronized (wakeLockGuard) {
            if (wakeLock != null) {
                try {
                    if (wakeLock.isHeld()) {
                        wakeLock.release();
                    }
                } catch (RuntimeException ignored) {
                }
            }
        }
    }

    private void updateKeepScreenOn(boolean keepOn) {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            return;
        }
        activity.runOnUiThread(() -> {
            if (activity.isFinishing() || activity.isDestroyed() || activity.getWindow() == null) {
                return;
            }
            if (keepOn) {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
    }
}
