package io.localfiction.harness;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Pure JVM controlled HTTPS update client without Android Framework dependencies.
 * Fetches release metadata JSON, streams APK downloads with SHA-256 and verifier checks,
 * supports cache reuse, atomic promotion, abort, and stale APK cleanup.
 */
public class ApkUpdateClient {
    public static class HttpStatusException extends IOException {
        private final int status;

        public HttpStatusException(int status, String message) {
            super(message);
            this.status = status;
        }

        public int getStatus() {
            return status;
        }
    }

    public static final class VerificationResult {
        public final boolean ok;
        public final String errorCode;
        public final String errorMessage;

        public VerificationResult(boolean ok, String errorCode, String errorMessage) {
            this.ok = ok;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
        }

        public static VerificationResult ok() {
            return new VerificationResult(true, null, null);
        }

        public static VerificationResult fail(String errorCode, String errorMessage) {
            return new VerificationResult(false, errorCode, errorMessage);
        }
    }

    public interface ApkVerifier {
        VerificationResult verify(File apkFile);
    }

    public interface Listener {
        void onProgress(String requestId, long downloadedBytes, long totalBytes);

        void onComplete(
            String requestId,
            String fileName,
            String version,
            String sha256,
            long sizeBytes,
            boolean reusedCache
        );

        void onError(String requestId, int status, String code, String message, boolean aborted);
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

    private static final int JSON_CONNECT_TIMEOUT_MS = 15_000;
    private static final int JSON_READ_TIMEOUT_MS = 20_000;
    private static final int APK_CONNECT_TIMEOUT_MS = 30_000;
    private static final int APK_READ_TIMEOUT_MS = 120_000;
    private static final int CHUNK_BUFFER_BYTES = 65_536;
    private static final int MAX_REDIRECTS = 5;
    private static final long PROGRESS_BYTES_INTERVAL = 128L * 1024L;
    private static final long PROGRESS_TIME_INTERVAL_MS = 120L;
    private static final String USER_AGENT = "Folio-Android";

    private final boolean allowLoopbackHttpForTest;
    private final ConcurrentHashMap<String, ActiveDownload> activeDownloads = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    public ApkUpdateClient() {
        this(false);
    }

    ApkUpdateClient(boolean allowLoopbackHttpForTest) {
        this.allowLoopbackHttpForTest = allowLoopbackHttpForTest;
    }

    public String fetchJson(String urlString, int maxBytes) throws IOException {
        if (urlString == null || urlString.trim().isEmpty()) {
            throw new IllegalArgumentException("URL cannot be empty.");
        }
        if (maxBytes <= 0) {
            throw new IllegalArgumentException("maxBytes must be greater than 0.");
        }

        HttpURLConnection conn = null;
        try {
            conn = openFollowingHttpsRedirects(
                null,
                urlString,
                "application/json",
                JSON_CONNECT_TIMEOUT_MS,
                JSON_READ_TIMEOUT_MS
            );
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new HttpStatusException(status, formatHttpError("fetch release metadata", status));
            }

            long declaredLength = conn.getContentLengthLong();
            if (declaredLength > maxBytes) {
                throw new IOException("JSON response exceeds maxBytes limit (" + maxBytes + ").");
            }

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[Math.min(CHUNK_BUFFER_BYTES, Math.max(1024, maxBytes))];
            long totalRead = 0;
            try (InputStream is = conn.getInputStream()) {
                int read;
                while ((read = is.read(buffer)) != -1) {
                    if (read <= 0) continue;
                    totalRead += read;
                    if (totalRead > maxBytes) {
                        throw new IOException("JSON response exceeds maxBytes limit (" + maxBytes + ").");
                    }
                    out.write(buffer, 0, read);
                }
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    public static String buildApkFileName(String version) {
        String safe = version == null ? "" : version.trim();
        while (!safe.isEmpty() && (safe.charAt(0) == 'v' || safe.charAt(0) == 'V')) {
            safe = safe.substring(1);
        }
        safe = safe.replaceAll("[^0-9A-Za-z._-]", "_");
        while (safe.contains("..")) {
            safe = safe.replace("..", "_");
        }
        if (safe.isEmpty() || ".".equals(safe)) {
            safe = "unknown";
        }
        return "Folio-v" + safe + ".apk";
    }

    public void downloadAndVerifyApk(
        String requestId,
        String urlString,
        File updatesDir,
        String version,
        String expectedSha256OrNull,
        long maxBytes,
        ApkVerifier verifier,
        Listener listener
    ) {
        if (listener == null) {
            throw new IllegalArgumentException("listener cannot be null.");
        }
        if (requestId == null || requestId.isEmpty()) {
            listener.onError("", 0, "INVALID_ARGUMENT", "requestId cannot be empty.", false);
            return;
        }
        if (urlString == null || urlString.trim().isEmpty()) {
            listener.onError(requestId, 0, "INVALID_ARGUMENT", "url cannot be empty.", false);
            return;
        }
        if (updatesDir == null) {
            listener.onError(requestId, 0, "INVALID_ARGUMENT", "updatesDir cannot be null.", false);
            return;
        }
        if (maxBytes <= 0) {
            listener.onError(requestId, 0, "INVALID_ARGUMENT", "maxBytes must be greater than 0.", false);
            return;
        }

        ActiveDownload download = new ActiveDownload(listener);
        if (activeDownloads.putIfAbsent(requestId, download) != null) {
            listener.onError(requestId, 0, "DUPLICATE_REQUEST", "Duplicate download requestId: " + requestId, false);
            return;
        }

        executor.submit(() ->
            runDownload(
                requestId,
                download,
                urlString,
                updatesDir,
                version,
                expectedSha256OrNull,
                maxBytes,
                verifier
            )
        );
    }

    public boolean abortDownload(String requestId) {
        ActiveDownload download = activeDownloads.get(requestId);
        if (download == null) {
            return false;
        }
        boolean wasAlreadyAborted = download.aborted.getAndSet(true);
        HttpURLConnection conn = download.connection;
        if (conn != null) {
            executor.submit(conn::disconnect);
        }
        return !wasAlreadyAborted;
    }

    public static String computeSha256Hex(File file) throws IOException {
        if (file == null || !file.isFile()) {
            throw new IOException("File does not exist for SHA-256 calculation.");
        }
        MessageDigest digest = newSha256Digest();
        byte[] buffer = new byte[CHUNK_BUFFER_BYTES];
        try (InputStream is = new FileInputStream(file)) {
            int read;
            while ((read = is.read(buffer)) != -1) {
                if (read > 0) {
                    digest.update(buffer, 0, read);
                }
            }
        }
        return toHexLower(digest.digest());
    }

    public static void cleanupStaleApks(File updatesDir, String keepVersionOrNull) {
        if (updatesDir == null || !updatesDir.isDirectory()) {
            return;
        }
        File[] files = updatesDir.listFiles();
        if (files == null) {
            return;
        }
        String keepFileName = (keepVersionOrNull != null && !keepVersionOrNull.trim().isEmpty())
            ? buildApkFileName(keepVersionOrNull)
            : null;
        for (File file : files) {
            if (!file.isFile()) {
                continue;
            }
            String name = file.getName();
            if (keepFileName == null) {
                file.delete();
            } else if (name.endsWith(".part") || (name.endsWith(".apk") && !keepFileName.equals(name))) {
                file.delete();
            }
        }
    }

    public void shutdown() {
        for (String id : activeDownloads.keySet()) {
            abortDownload(id);
        }
        executor.shutdownNow();
    }

    private void runDownload(
        String requestId,
        ActiveDownload download,
        String urlString,
        File updatesDir,
        String version,
        String expectedSha256OrNull,
        long maxBytes,
        ApkVerifier verifier
    ) {
        Listener listener = download.listener;
        String fileName = buildApkFileName(version);
        File targetFile = new File(updatesDir, fileName);
        File partFile = new File(updatesDir, fileName + ".part");
        HttpURLConnection conn = null;
        boolean promoted = false;

        try {
            if (!updatesDir.exists() && !updatesDir.mkdirs() && !updatesDir.isDirectory()) {
                emitError(download, requestId, 0, "IO_ERROR", "Failed to create updates directory.", false);
                return;
            }

            if (download.aborted.get()) {
                emitError(download, requestId, 0, "ABORTED", "Download aborted.", true);
                return;
            }

            String expectedShaNormalized = normalizeSha256OrNull(expectedSha256OrNull);

            if (targetFile.isFile()) {
                if (tryReuseCachedApk(
                    requestId,
                    download,
                    targetFile,
                    fileName,
                    version,
                    expectedShaNormalized,
                    maxBytes,
                    verifier
                )) {
                    return;
                }
                targetFile.delete();
            }

            if (partFile.exists()) {
                partFile.delete();
            }

            conn = openFollowingHttpsRedirects(
                download,
                urlString,
                "application/vnd.android.package-archive, application/octet-stream, */*",
                APK_CONNECT_TIMEOUT_MS,
                APK_READ_TIMEOUT_MS
            );
            if (conn == null || download.aborted.get()) {
                emitError(download, requestId, 0, "ABORTED", "Download aborted.", true);
                return;
            }

            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                emitError(
                    download,
                    requestId,
                    status,
                    "HTTP_" + status,
                    formatHttpError("download APK", status),
                    false
                );
                return;
            }

            long declaredLength = conn.getContentLengthLong();
            long totalBytes = declaredLength > 0 ? declaredLength : -1L;
            if (declaredLength > maxBytes) {
                emitError(
                    download,
                    requestId,
                    0,
                    "FILE_TOO_LARGE",
                    "APK size exceeds maximum allowed limit.",
                    false
                );
                return;
            }

            String contentType = conn.getContentType();
            MessageDigest digest = newSha256Digest();
            byte[] headerProbe = new byte[4];
            int headerBytes = 0;
            long totalRead = 0;
            long lastProgressBytes = 0;
            long lastProgressTimeMs = System.currentTimeMillis();

            String streamErrorCode = null;
            String streamErrorMessage = null;

            try (
                InputStream is = conn.getInputStream();
                FileOutputStream fos = new FileOutputStream(partFile)
            ) {
                byte[] buffer = new byte[CHUNK_BUFFER_BYTES];
                int read;
                while (!download.aborted.get() && (read = is.read(buffer)) != -1) {
                    if (read <= 0) continue;
                    totalRead += read;
                    if (totalRead > maxBytes) {
                        streamErrorCode = "FILE_TOO_LARGE";
                        streamErrorMessage = "Downloaded APK exceeds maximum allowed size.";
                        break;
                    }

                    if (headerBytes < 4) {
                        int copyLen = Math.min(4 - headerBytes, read);
                        System.arraycopy(buffer, 0, headerProbe, headerBytes, copyLen);
                        headerBytes += copyLen;
                        if (headerBytes >= 4 && !isPkMagic(headerProbe)) {
                            String headStr = new String(headerProbe, StandardCharsets.US_ASCII);
                            boolean htmlHint = (contentType != null && contentType.toLowerCase(Locale.ROOT).contains("text/html"))
                                || headStr.trim().startsWith("<");
                            streamErrorCode = "INVALID_APK";
                            streamErrorMessage = htmlHint
                                ? "Download returned an HTML page instead of an APK archive."
                                : "Downloaded file does not start with a valid APK (PK) header.";
                            break;
                        }
                    }

                    fos.write(buffer, 0, read);
                    digest.update(buffer, 0, read);

                    long nowMs = System.currentTimeMillis();
                    if (
                        totalRead - lastProgressBytes >= PROGRESS_BYTES_INTERVAL
                            || nowMs - lastProgressTimeMs >= PROGRESS_TIME_INTERVAL_MS
                    ) {
                        lastProgressBytes = totalRead;
                        lastProgressTimeMs = nowMs;
                        listener.onProgress(requestId, totalRead, totalBytes);
                    }
                }
                fos.flush();
            }

            if (download.aborted.get()) {
                deleteQuietly(partFile);
                emitError(download, requestId, 0, "ABORTED", "Download aborted.", true);
                return;
            }

            if (streamErrorCode != null) {
                deleteQuietly(partFile);
                emitError(download, requestId, 0, streamErrorCode, streamErrorMessage, false);
                return;
            }

            if (headerBytes < 4 || !isPkMagic(headerProbe)) {
                deleteQuietly(partFile);
                emitError(
                    download,
                    requestId,
                    0,
                    "INVALID_APK",
                    "Downloaded file is empty or missing valid APK (PK) header.",
                    false
                );
                return;
            }

            if (totalRead > lastProgressBytes) {
                listener.onProgress(requestId, totalRead, totalBytes);
            }

            String actualSha256 = toHexLower(digest.digest());
            if (expectedShaNormalized != null && !actualSha256.equalsIgnoreCase(expectedShaNormalized)) {
                deleteQuietly(partFile);
                emitError(
                    download,
                    requestId,
                    0,
                    "SHA256_MISMATCH",
                    "Downloaded APK SHA-256 checksum does not match expected value.",
                    false
                );
                return;
            }

            if (verifier != null) {
                VerificationResult verification = verifier.verify(partFile);
                if (verification == null || !verification.ok) {
                    deleteQuietly(partFile);
                    String errCode = (verification != null && verification.errorCode != null && !verification.errorCode.isEmpty())
                        ? verification.errorCode
                        : "VERIFICATION_FAILED";
                    String errMsg = (verification != null && verification.errorMessage != null && !verification.errorMessage.isEmpty())
                        ? verification.errorMessage
                        : "APK verification failed.";
                    emitError(download, requestId, 0, errCode, errMsg, false);
                    return;
                }
            }

            replaceFileAtomically(partFile, targetFile);
            promoted = true;

            if (download.finished.compareAndSet(false, true)) {
                listener.onComplete(
                    requestId,
                    fileName,
                    version != null ? version : "",
                    actualSha256,
                    targetFile.length(),
                    false
                );
            }
        } catch (Exception err) {
            deleteQuietly(partFile);
            if (download.aborted.get()) {
                emitError(download, requestId, 0, "ABORTED", "Download aborted.", true);
            } else {
                String msg = err.getMessage();
                String code = (err instanceof IllegalArgumentException) ? "INVALID_URL" : "DOWNLOAD_FAILED";
                emitError(
                    download,
                    requestId,
                    0,
                    code,
                    msg != null && !msg.isEmpty() ? msg : err.getClass().getSimpleName(),
                    false
                );
            }
        } finally {
            if (!promoted) {
                deleteQuietly(partFile);
            }
            activeDownloads.remove(requestId, download);
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private boolean tryReuseCachedApk(
        String requestId,
        ActiveDownload download,
        File targetFile,
        String fileName,
        String version,
        String expectedShaNormalized,
        long maxBytes,
        ApkVerifier verifier
    ) {
        try {
            long size = targetFile.length();
            if (size <= 0 || size > maxBytes || !hasValidPkHeader(targetFile)) {
                return false;
            }
            String cachedSha = computeSha256Hex(targetFile);
            if (expectedShaNormalized != null && !cachedSha.equalsIgnoreCase(expectedShaNormalized)) {
                return false;
            }
            if (verifier != null) {
                VerificationResult vr = verifier.verify(targetFile);
                if (vr == null || !vr.ok) {
                    return false;
                }
            }
            if (download.aborted.get()) {
                return false;
            }
            if (download.finished.compareAndSet(false, true)) {
                download.listener.onComplete(
                    requestId,
                    fileName,
                    version != null ? version : "",
                    cachedSha,
                    size,
                    true
                );
            }
            return true;
        } catch (IOException ignored) {
            return false;
        }
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
        throw new IllegalArgumentException("Only secure HTTPS (https://) URLs are supported.");
    }

    private HttpURLConnection openFollowingHttpsRedirects(
        ActiveDownload download,
        String initialUrl,
        String acceptHeader,
        int connectTimeoutMs,
        int readTimeoutMs
    ) throws IOException {
        URI currentUri = URI.create(initialUrl.trim());
        validateAllowedUri(currentUri);

        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            HttpURLConnection conn = (HttpURLConnection) currentUri.toURL().openConnection();
            if (download != null) {
                download.connection = conn;
            }
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(connectTimeoutMs);
            conn.setReadTimeout(readTimeoutMs);
            conn.setUseCaches(false);
            conn.setDoInput(true);
            conn.setRequestProperty("Accept", acceptHeader);
            conn.setRequestProperty("User-Agent", USER_AGENT);

            if (download != null && download.aborted.get()) {
                conn.disconnect();
                return null;
            }

            int status = conn.getResponseCode();
            if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                if (location == null || location.trim().isEmpty()) {
                    throw new IOException("Redirect response missing Location header.");
                }
                currentUri = currentUri.resolve(location.trim());
                validateAllowedUri(currentUri);
                continue;
            }
            return conn;
        }
        throw new IOException("Too many redirects (max " + MAX_REDIRECTS + ").");
    }

    private static void replaceFileAtomically(File partFile, File targetFile) throws IOException {
        try {
            Files.move(
                partFile.toPath(),
                targetFile.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE
            );
            return;
        } catch (AtomicMoveNotSupportedException | LinkageError ignored) {
            // Fall through to delete + rename fallback
        } catch (IOException moveErr) {
            // Try fallback before failing
            if (targetFile.exists() && !targetFile.delete()) {
                throw moveErr;
            }
            if (partFile.renameTo(targetFile)) {
                return;
            }
            throw moveErr;
        }

        if (targetFile.exists() && !targetFile.delete()) {
            throw new IOException("Failed to remove existing target APK before rename.");
        }
        if (!partFile.renameTo(targetFile)) {
            throw new IOException("Failed to rename verified APK to target path.");
        }
    }

    private static void emitError(
        ActiveDownload download,
        String requestId,
        int status,
        String code,
        String message,
        boolean aborted
    ) {
        if (download.finished.compareAndSet(false, true)) {
            download.listener.onError(requestId, status, code, message, aborted);
        }
    }

    private static boolean hasValidPkHeader(File file) throws IOException {
        byte[] header = new byte[4];
        try (InputStream is = new FileInputStream(file)) {
            int total = 0;
            while (total < 4) {
                int r = is.read(header, total, 4 - total);
                if (r == -1) break;
                total += r;
            }
            return total >= 4 && isPkMagic(header);
        }
    }

    private static boolean isPkMagic(byte[] header) {
        return header.length >= 2 && header[0] == 0x50 && header[1] == 0x4b;
    }

    private static String normalizeSha256OrNull(String sha256) {
        if (sha256 == null) return null;
        String trimmed = sha256.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static String formatHttpError(String action, int status) {
        if (status == 403 || status == 429) {
            return "Rate-limited or network/access forbidden while trying to " + action + " (HTTP " + status + ").";
        }
        return "Failed to " + action + " (HTTP " + status + ").";
    }

    private static MessageDigest newSha256Digest() throws IOException {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException err) {
            throw new IOException("SHA-256 algorithm is unavailable.", err);
        }
    }

    private static String toHexLower(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists()) {
            file.delete();
        }
    }
}
