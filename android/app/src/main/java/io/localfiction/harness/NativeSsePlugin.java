package io.localfiction.harness;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

@CapacitorPlugin(name = "NativeSse")
public class NativeSsePlugin extends Plugin {
    private final SseStreamClient streamClient = new SseStreamClient();

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

        streamClient.startStream(requestId, url, headers, body, new SseStreamClient.Listener() {
            @Override
            public void onChunk(String reqId, byte[] chunk, int length) {
                JSObject data = new JSObject();
                data.put("requestId", reqId);
                data.put("chunkBase64", Base64.encodeToString(chunk, 0, length, Base64.NO_WRAP));
                notifyListeners("sseChunk", data);
            }

            @Override
            public void onComplete(String reqId) {
                JSObject data = new JSObject();
                data.put("requestId", reqId);
                notifyListeners("sseComplete", data);
            }

            @Override
            public void onError(String reqId, int status, String message, boolean aborted) {
                JSObject data = new JSObject();
                data.put("requestId", reqId);
                data.put("message", message);
                if (status > 0) {
                    data.put("status", status);
                }
                if (aborted) {
                    data.put("aborted", true);
                }
                notifyListeners("sseError", data);
            }
        });

        call.resolve();
    }

    @PluginMethod
    public void abortStream(PluginCall call) {
        String requestId = call.getString("requestId");
        if (requestId != null && !requestId.isEmpty()) {
            streamClient.abortStream(requestId);
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        streamClient.shutdown();
        super.handleOnDestroy();
    }
}
