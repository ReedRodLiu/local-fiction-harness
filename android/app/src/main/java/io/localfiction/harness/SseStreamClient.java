package io.localfiction.harness;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Pure JVM chunked HTTP/SSE streaming client without Android Framework dependencies.
 * Reads raw bytes incrementally and dispatches chunks immediately without buffering the full body.
 */
public class SseStreamClient {
    public interface Listener {
        void onChunk(String requestId, byte[] chunk, int length);

        void onComplete(String requestId);

        void onError(String requestId, int status, String message, boolean aborted);
    }

    private static final class ActiveCall {
        final AtomicBoolean aborted = new AtomicBoolean(false);
        final AtomicBoolean finished = new AtomicBoolean(false);
        volatile HttpURLConnection connection;
    }

    private static final int CONNECT_TIMEOUT_MS = 30_000;
    private static final int READ_TIMEOUT_MS = 120_000;
    private static final int CHUNK_BUFFER_BYTES = 4096;
    private static final int MAX_ERROR_BODY_BYTES = 2048;

    private final ConcurrentHashMap<String, ActiveCall> activeCalls = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    public void startStream(
        String requestId,
        String urlString,
        String method,
        Map<String, String> headers,
        String body,
        Listener listener
    ) {
        if (requestId == null || requestId.isEmpty()) {
            listener.onError("", 0, "requestId 不能为空。", false);
            return;
        }
        ActiveCall call = new ActiveCall();
        ActiveCall existing = activeCalls.putIfAbsent(requestId, call);
        if (existing != null) {
            listener.onError(requestId, 0, "重复的流式请求 ID: " + requestId, false);
            return;
        }

        executor.submit(() -> runRequest(requestId, call, urlString, method, headers, body, listener));
    }

    public boolean abortStream(String requestId) {
        ActiveCall call = activeCalls.get(requestId);
        if (call == null) {
            return false;
        }
        boolean wasAlreadyAborted = call.aborted.getAndSet(true);
        HttpURLConnection conn = call.connection;
        if (conn != null) {
            conn.disconnect();
        }
        return !wasAlreadyAborted;
    }

    public void shutdown() {
        for (String id : activeCalls.keySet()) {
            abortStream(id);
        }
        executor.shutdownNow();
    }

    private void runRequest(
        String requestId,
        ActiveCall call,
        String urlString,
        String method,
        Map<String, String> headers,
        String body,
        Listener listener
    ) {
        HttpURLConnection conn = null;
        try {
            URI uri = URI.create(urlString);
            String scheme = uri.getScheme();
            if (scheme == null || (!scheme.equalsIgnoreCase("https") && !scheme.equalsIgnoreCase("http"))) {
                throw new IllegalArgumentException("仅支持 HTTP/HTTPS 模型端点 URL。");
            }
            URL url = uri.toURL();
            conn = (HttpURLConnection) url.openConnection();
            call.connection = conn;

            if (call.aborted.get()) {
                emitAbort(requestId, call, listener);
                return;
            }

            conn.setRequestMethod(method == null || method.isEmpty() ? "POST" : method);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setUseCaches(false);
            conn.setDoInput(true);

            if (headers != null) {
                for (Map.Entry<String, String> entry : headers.entrySet()) {
                    if (entry.getKey() != null && entry.getValue() != null) {
                        conn.setRequestProperty(entry.getKey(), entry.getValue());
                    }
                }
            }

            if (body != null && !body.isEmpty()) {
                conn.setDoOutput(true);
                byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(payload);
                    os.flush();
                }
            }

            if (call.aborted.get()) {
                emitAbort(requestId, call, listener);
                return;
            }

            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                String detail = readErrorDetail(conn);
                String statusMessage = conn.getResponseMessage();
                String fullMsg = "Model request failed with HTTP " + status
                    + (statusMessage != null && !statusMessage.isEmpty() ? " " + statusMessage : "")
                    + (!detail.isEmpty() ? ": " + detail : "");
                if (call.finished.compareAndSet(false, true)) {
                    listener.onError(requestId, status, fullMsg, false);
                }
                return;
            }

            try (InputStream is = conn.getInputStream()) {
                byte[] buffer = new byte[CHUNK_BUFFER_BYTES];
                int read;
                while (!call.aborted.get() && (read = is.read(buffer)) != -1) {
                    if (read > 0) {
                        byte[] copy = new byte[read];
                        System.arraycopy(buffer, 0, copy, 0, read);
                        listener.onChunk(requestId, copy, read);
                    }
                }
            }

            if (call.aborted.get()) {
                emitAbort(requestId, call, listener);
            } else if (call.finished.compareAndSet(false, true)) {
                listener.onComplete(requestId);
            }
        } catch (Exception err) {
            if (call.aborted.get()) {
                emitAbort(requestId, call, listener);
            } else if (call.finished.compareAndSet(false, true)) {
                String msg = err.getMessage();
                listener.onError(
                    requestId,
                    0,
                    msg != null && !msg.isEmpty() ? msg : err.getClass().getSimpleName(),
                    false
                );
            }
        } finally {
            activeCalls.remove(requestId, call);
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static void emitAbort(String requestId, ActiveCall call, Listener listener) {
        if (call.finished.compareAndSet(false, true)) {
            listener.onError(requestId, 0, "操作已中止。", true);
        }
    }

    private static String readErrorDetail(HttpURLConnection conn) {
        InputStream errStream = conn.getErrorStream();
        if (errStream == null) {
            return "";
        }
        try (InputStream is = errStream; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[512];
            int total = 0;
            int read;
            while (total < MAX_ERROR_BODY_BYTES && (read = is.read(buf, 0, Math.min(buf.length, MAX_ERROR_BODY_BYTES - total))) != -1) {
                out.write(buf, 0, read);
                total += read;
            }
            return out.toString(StandardCharsets.UTF_8).trim();
        } catch (IOException ignored) {
            return "";
        }
    }
}
