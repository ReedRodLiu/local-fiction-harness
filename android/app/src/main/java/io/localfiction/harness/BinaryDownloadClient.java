package io.localfiction.harness;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Pure JVM controlled HTTPS GET binary downloader without Android Framework dependencies.
 * Enforces strict HTTPS (including redirect targets), streaming maxBytes ceiling, PK magic check, and abort.
 */
public class BinaryDownloadClient {
    public interface Listener {
        void onChunk(String requestId, byte[] chunk, int length);

        void onComplete(String requestId, String contentType);

        void onError(String requestId, int status, String message, boolean aborted);
    }

    private static final class ActiveDownload {
        final Listener listener;
        final AtomicBoolean aborted = new AtomicBoolean(false);
        final AtomicBoolean finished = new AtomicBoolean(false);
        volatile HttpURLConnection connection;

        ActiveDownload(Listener listener) {
            this.listener = listener;
        }
    }

    private static final int CONNECT_TIMEOUT_MS = 30_000;
    private static final int READ_TIMEOUT_MS = 120_000;
    private static final int CHUNK_BUFFER_BYTES = 65_536;
    private static final int MAX_REDIRECTS = 5;

    private final boolean allowLoopbackHttpForTest;
    private final ConcurrentHashMap<String, ActiveDownload> activeDownloads = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    public BinaryDownloadClient() {
        this(false);
    }

    BinaryDownloadClient(boolean allowLoopbackHttpForTest) {
        this.allowLoopbackHttpForTest = allowLoopbackHttpForTest;
    }

    public void startDownload(
        String requestId,
        String urlString,
        long maxBytes,
        Listener listener
    ) {
        if (requestId == null || requestId.isEmpty()) {
            listener.onError("", 0, "requestId 不能为空。", false);
            return;
        }
        if (maxBytes <= 0) {
            listener.onError(requestId, 0, "maxBytes 必须大于 0。", false);
            return;
        }
        ActiveDownload download = new ActiveDownload(listener);
        if (activeDownloads.putIfAbsent(requestId, download) != null) {
            listener.onError(requestId, 0, "重复的下载请求 ID: " + requestId, false);
            return;
        }
        executor.submit(() -> runDownload(requestId, download, urlString, maxBytes));
    }

    public boolean abortDownload(String requestId) {
        ActiveDownload download = activeDownloads.get(requestId);
        if (download == null) {
            return false;
        }
        boolean wasAlreadyAborted = download.aborted.getAndSet(true);
        emitAbort(requestId, download, download.listener);
        HttpURLConnection conn = download.connection;
        if (conn != null) {
            executor.submit(conn::disconnect);
        }
        return !wasAlreadyAborted;
    }

    public void shutdown() {
        for (String id : activeDownloads.keySet()) {
            abortDownload(id);
        }
        executor.shutdownNow();
    }

    private void validateAllowedUri(URI uri) {
        String scheme = uri.getScheme();
        if ("https".equalsIgnoreCase(scheme)) {
            return;
        }
        if (allowLoopbackHttpForTest && "http".equalsIgnoreCase(scheme)) {
            String host = uri.getHost();
            if ("127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host)) {
                return;
            }
        }
        throw new IllegalArgumentException("仅支持安全的 HTTPS（https://）下载链接。");
    }

    private HttpURLConnection openFollowingHttpsRedirects(ActiveDownload download, String initialUrl)
        throws IOException {
        URI currentUri = URI.create(initialUrl.trim());
        validateAllowedUri(currentUri);

        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            HttpURLConnection conn = (HttpURLConnection) currentUri.toURL().openConnection();
            download.connection = conn;
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setUseCaches(false);
            conn.setDoInput(true);

            if (download.aborted.get()) {
                conn.disconnect();
                return null;
            }

            int status = conn.getResponseCode();
            if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                if (location == null || location.trim().isEmpty()) {
                    throw new IOException("重定向响应缺少 Location 目标。");
                }
                currentUri = currentUri.resolve(location.trim());
                validateAllowedUri(currentUri);
                continue;
            }
            return conn;
        }
        throw new IOException("重定向次数过多，已中止下载。");
    }

    private void runDownload(
        String requestId,
        ActiveDownload download,
        String urlString,
        long maxBytes
    ) {
        Listener listener = download.listener;
        HttpURLConnection conn = null;
        try {
            if (urlString == null || urlString.trim().isEmpty()) {
                throw new IllegalArgumentException("下载链接不能为空。");
            }
            conn = openFollowingHttpsRedirects(download, urlString);
            if (conn == null || download.aborted.get()) {
                emitAbort(requestId, download, listener);
                return;
            }

            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                String msg = (status == 401 || status == 403)
                    ? "导出链接需要登录态或已失效（HTTP " + status + "），请先在浏览器下载 .zip 后选择本地文件导入。"
                    : "下载导出压缩包失败（HTTP " + status + "）。";
                if (download.finished.compareAndSet(false, true)) {
                    listener.onError(requestId, status, msg, false);
                }
                return;
            }

            long declaredLength = conn.getContentLengthLong();
            if (declaredLength > maxBytes) {
                if (download.finished.compareAndSet(false, true)) {
                    listener.onError(requestId, 0, "导出压缩包体积超出安全大小上限，已拒绝下载。", false);
                }
                return;
            }

            String contentType = conn.getContentType();
            byte[] headerProbe = new byte[4];
            int headerBytes = 0;
            long totalRead = 0;

            try (InputStream is = conn.getInputStream()) {
                byte[] buffer = new byte[CHUNK_BUFFER_BYTES];
                int read;
                while (!download.aborted.get() && (read = is.read(buffer)) != -1) {
                    if (read <= 0) continue;
                    totalRead += read;
                    if (totalRead > maxBytes) {
                        if (download.finished.compareAndSet(false, true)) {
                            listener.onError(requestId, 0, "导出压缩包体积超出安全大小上限，已中止下载。", false);
                        }
                        return;
                    }

                    if (headerBytes < 4) {
                        int copyLen = Math.min(4 - headerBytes, read);
                        System.arraycopy(buffer, 0, headerProbe, headerBytes, copyLen);
                        headerBytes += copyLen;
                        if (headerBytes >= 4 && (headerProbe[0] != 0x50 || headerProbe[1] != 0x4b)) {
                            String headStr = new String(headerProbe, StandardCharsets.US_ASCII);
                            boolean htmlHint = (contentType != null && contentType.toLowerCase().contains("text/html"))
                                || headStr.trim().startsWith("<");
                            String errMsg = htmlHint
                                ? "链接返回了 HTML 登录/错误页面而非 .zip（请先在浏览器下载 .zip 后本地导入）。"
                                : "下载内容缺少有效 ZIP (PK) 魔数头。";
                            if (download.finished.compareAndSet(false, true)) {
                                listener.onError(requestId, 0, errMsg, false);
                            }
                            return;
                        }
                    }

                    byte[] copy = new byte[read];
                    System.arraycopy(buffer, 0, copy, 0, read);
                    listener.onChunk(requestId, copy, read);
                }
            }

            if (download.aborted.get()) {
                emitAbort(requestId, download, listener);
                return;
            }
            if (headerBytes < 4 || headerProbe[0] != 0x50 || headerProbe[1] != 0x4b) {
                if (download.finished.compareAndSet(false, true)) {
                    listener.onError(requestId, 0, "下载内容为空或缺少有效 ZIP (PK) 魔数头。", false);
                }
                return;
            }
            if (download.finished.compareAndSet(false, true)) {
                listener.onComplete(requestId, contentType != null ? contentType : "");
            }
        } catch (Exception err) {
            if (download.aborted.get()) {
                emitAbort(requestId, download, listener);
            } else if (download.finished.compareAndSet(false, true)) {
                String msg = err.getMessage();
                listener.onError(
                    requestId,
                    0,
                    msg != null && !msg.isEmpty() ? msg : err.getClass().getSimpleName(),
                    false
                );
            }
        } finally {
            activeDownloads.remove(requestId, download);
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static void emitAbort(String requestId, ActiveDownload download, Listener listener) {
        if (download.finished.compareAndSet(false, true)) {
            listener.onError(requestId, 0, "已取消拉取导出压缩包。", true);
        }
    }
}
