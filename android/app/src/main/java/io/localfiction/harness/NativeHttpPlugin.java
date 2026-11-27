package io.localfiction.harness;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "NativeHttp")
public class NativeHttpPlugin extends Plugin {
    private final HttpTextClient httpTextClient = new HttpTextClient();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @PluginMethod
    public void fetchText(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("url is required.");
            return;
        }

        Map<String, String> headers = extractHeaders(call.getObject("headers"));
        Integer maxBytesObj = call.getInt("maxBytes", HttpTextClient.MAX_BYTES_CAP);
        int maxBytes = maxBytesObj != null ? maxBytesObj : HttpTextClient.MAX_BYTES_CAP;
        Integer timeoutMsObj = call.getInt("timeoutMs", HttpTextClient.DEFAULT_TIMEOUT_MS);
        int timeoutMs = timeoutMsObj != null ? timeoutMsObj : HttpTextClient.DEFAULT_TIMEOUT_MS;

        executor.submit(() -> {
            try {
                HttpTextClient.FetchResult res = httpTextClient.fetchText(
                    url,
                    headers,
                    maxBytes,
                    timeoutMs
                );
                JSObject payload = new JSObject();
                payload.put("status", res.status);
                payload.put("finalUrl", res.finalUrl);
                payload.put("text", res.text);
                payload.put("truncated", res.truncated);
                call.resolve(payload);
            } catch (Exception err) {
                String msg = err.getMessage();
                call.reject(
                    msg != null && !msg.isEmpty() ? msg : err.getClass().getSimpleName(),
                    err
                );
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }

    private static Map<String, String> extractHeaders(JSObject headersObj) {
        if (headersObj == null) {
            return null;
        }
        Map<String, String> headers = new LinkedHashMap<>();
        Iterator<String> keys = headersObj.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            String value = headersObj.getString(key);
            if (value != null) {
                headers.put(key, value);
            }
        }
        return headers;
    }
}
