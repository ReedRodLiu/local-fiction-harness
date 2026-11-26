package io.localfiction.harness;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.SSLException;

/**
 * Pure JVM chunked HTTP/SSE streaming POST client without Android Framework dependencies.
 * Reads raw bytes incrementally and dispatches chunks immediately without buffering the full body.
 */
public class SseStreamClient {
    public static final class ClassifiedError {
        public final String code;
        public final String message;

        public ClassifiedError(String code, String message) {
            this.code = code;
            this.message = message;
        }
    }

    public interface Listener {
        void onChunk(String requestId, byte[] chunk, int length);

        void onComplete(String requestId);

        void onError(String requestId, int status, String message, boolean aborted);

        default void onError(String requestId, int status, String code, String message, boolean aborted) {
            onError(requestId, status, message, aborted);
        }
    }

    private static final class ActiveCall {
        final Listener listener;
        final AtomicBoolean aborted = new AtomicBoolean(false);
        final AtomicBoolean finished = new AtomicBoolean(false);
        volatile HttpURLConnection connection;

        ActiveCall(Listener listener) {
            this.listener = listener;
        }
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
        Map<String, String> headers,
        String body,
        Listener listener
    ) {
        if (requestId == null || requestId.isEmpty()) {
            listener.onError("", 0, "requestId 不能为空。", false);
            return;
        }
        ActiveCall call = new ActiveCall(listener);
        ActiveCall existing = activeCalls.putIfAbsent(requestId, call);
        if (existing != null) {
            listener.onError(requestId, 0, "重复的流式请求 ID: " + requestId, false);
            return;
        }

        executor.submit(() -> runRequest(requestId, call, urlString, headers, body));
    }

    public boolean abortStream(String requestId) {
        ActiveCall call = activeCalls.get(requestId);
        if (call == null) {
            return false;
        }
        boolean wasAlreadyAborted = call.aborted.getAndSet(true);
        emitAbort(requestId, call, call.listener);
        HttpURLConnection conn = call.connection;
        if (conn != null) {
            executor.submit(conn::disconnect);
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
        Map<String, String> headers,
        String body
    ) {
        Listener listener = call.listener;
        HttpURLConnection conn = null;
        long receivedBytes = 0L;
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
                conn.disconnect();
                emitAbort(requestId, call, listener);
                return;
            }

            conn.setRequestMethod("POST");
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
                    listener.onError(requestId, status, "HTTP_" + status, fullMsg, false);
                }
                return;
            }

            try (InputStream is = conn.getInputStream()) {
                byte[] buffer = new byte[CHUNK_BUFFER_BYTES];
                int read;
                while (!call.aborted.get() && (read = is.read(buffer)) != -1) {
                    if (read > 0) {
                        receivedBytes += read;
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
                ClassifiedError classified = classifyException(err);
                String message = receivedBytes > 0
                    ? classified.message + "（断线前已接收 " + receivedBytes + " B）"
                    : classified.message;
                listener.onError(
                    requestId,
                    0,
                    classified.code,
                    message,
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

    public static ClassifiedError classifyException(Throwable err) {
        if (err == null) {
            return new ClassifiedError("NETWORK_ERROR", "网络请求异常中断，请重试。");
        }
        String rawMsg = err.getMessage() != null ? err.getMessage().trim() : "";
        String lower = rawMsg.toLowerCase(Locale.ROOT);

        if (err instanceof SocketTimeoutException || lower.contains("timed out")) {
            return new ClassifiedError(
                "TIMEOUT",
                "等待模型响应超时，请稍后重试；若使用了较高思考强度，可在等待期间保持屏幕亮起。"
            );
        }
        if (err instanceof UnknownHostException || lower.contains("unable to resolve host")) {
            return new ClassifiedError(
                "DNS_ERROR",
                "无法解析模型服务器域名，请检查网络连接或 DNS / VPN 设置。"
            );
        }
        if (err instanceof SSLException) {
            return new ClassifiedError(
                "TLS_ERROR",
                "HTTPS 安全连接握手或传输中断，请检查系统时间、网络或 VPN 代理设置后重试。"
            );
        }
        if (err instanceof EOFException || lower.contains("unexpected end of stream")) {
            return new ClassifiedError(
                "STREAM_EOF",
                "模型响应流意外提前结束，可能是网络波动导致，请重试。"
            );
        }
        if (err instanceof SocketException) {
            if (lower.contains("connection abort") || lower.contains("econnaborted")) {
                return new ClassifiedError(
                    "CONNECTION_ABORTED",
                    "网络连接在等待响应期间被系统或网络切换中断（如锁屏、切后台、VPN 或 Wi-Fi/5G 切换），请保持网络稳定并在系统设置中允许 Folio 后台运行后重试。"
                );
            }
            if (lower.contains("connection reset") || lower.contains("econnreset") || lower.contains("broken pipe")) {
                return new ClassifiedError(
                    "SOCKET_RESET",
                    "与模型服务器的连接意外重置，可能是网络波动或 VPN 隧道断开，请重试。"
                );
            }
            return new ClassifiedError(
                "SOCKET_ERROR",
                "网络连接中断，请检查网络或 VPN 状态后重试。"
            );
        }
        if (
            lower.contains("software caused connection abort")
                || lower.contains("connection abort")
                || lower.contains("econnaborted")
        ) {
            return new ClassifiedError(
                "CONNECTION_ABORTED",
                "网络连接在等待响应期间被系统或网络切换中断（如锁屏、切后台、VPN 或 Wi-Fi/5G 切换），请保持网络稳定并在系统设置中允许 Folio 后台运行后重试。"
            );
        }
        Throwable cause = err.getCause();
        if (cause != null && cause != err) {
            ClassifiedError causeClassified = classifyException(cause);
            if (!"NETWORK_ERROR".equals(causeClassified.code)) {
                return causeClassified;
            }
        }
        return new ClassifiedError(
            "NETWORK_ERROR",
            !rawMsg.isEmpty() ? rawMsg : err.getClass().getSimpleName()
        );
    }

    private static void emitAbort(String requestId, ActiveCall call, Listener listener) {
        if (call.finished.compareAndSet(false, true)) {
            listener.onError(requestId, 0, "ABORTED", "操作已中止。", true);
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
