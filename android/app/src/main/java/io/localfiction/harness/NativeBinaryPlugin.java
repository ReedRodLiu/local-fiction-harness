package io.localfiction.harness;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeBinary")
public class NativeBinaryPlugin extends Plugin {
    private static final long DEFAULT_MAX_BYTES = 100L * 1024L * 1024L;
    private final BinaryDownloadClient downloadClient = new BinaryDownloadClient(
        BuildConfig.ALLOW_LOOPBACK_HTTP
    );

    @PluginMethod
    public void startDownload(PluginCall call) {
        String requestId = call.getString("requestId");
        String url = call.getString("url");
        Long maxBytesObj = call.getLong("maxBytes", DEFAULT_MAX_BYTES);
        long maxBytes = maxBytesObj != null && maxBytesObj > 0 ? maxBytesObj : DEFAULT_MAX_BYTES;

        if (requestId == null || requestId.isEmpty() || url == null || url.isEmpty()) {
            call.reject("requestId and url are required.");
            return;
        }

        downloadClient.startDownload(requestId, url, maxBytes, new BinaryDownloadClient.Listener() {
            @Override
            public void onChunk(String reqId, byte[] chunk, int length) {
                JSObject data = new JSObject();
                data.put("requestId", reqId);
                data.put("chunkBase64", Base64.encodeToString(chunk, 0, length, Base64.NO_WRAP));
                notifyListeners("binaryChunk", data);
            }

            @Override
            public void onComplete(String reqId, String contentType) {
                JSObject data = new JSObject();
                data.put("requestId", reqId);
                if (contentType != null && !contentType.isEmpty()) {
                    data.put("contentType", contentType);
                }
                notifyListeners("binaryComplete", data);
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
                notifyListeners("binaryError", data);
            }
        });

        call.resolve();
    }

    @PluginMethod
    public void abortDownload(PluginCall call) {
        String requestId = call.getString("requestId");
        if (requestId != null && !requestId.isEmpty()) {
            downloadClient.abortDownload(requestId);
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        downloadClient.shutdown();
        super.handleOnDestroy();
    }
}
