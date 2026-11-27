package io.localfiction.harness;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Pure JVM HTTPS text fetcher without Android Framework dependencies.
 * Enforces strict https:// URLs, manual redirect validation (max 3 hops),
 * credential header stripping, and bounded UTF-8 response reading.
 */
public class HttpTextClient {
    public static final int MAX_BYTES_CAP = 512 * 1024;
    public static final int DEFAULT_TIMEOUT_MS = 8_000;
    public static final int MAX_TIMEOUT_MS = 10_000;
    public static final int MAX_REDIRECTS = 3;

    private static final int READ_BUFFER_BYTES = 8_192;
    private static final Set<String> ALLOWED_HEADERS = Set.of(
        "accept",
        "accept-language",
        "user-agent"
    );

    @FunctionalInterface
    public interface ConnectionFactory {
        HttpURLConnection open(URI uri) throws IOException;
    }

    public static final class FetchResult {
        public final int status;
        public final String finalUrl;
        public final String text;
        public final boolean truncated;

        public FetchResult(int status, String finalUrl, String text, boolean truncated) {
            this.status = status;
            this.finalUrl = finalUrl;
            this.text = text;
            this.truncated = truncated;
        }
    }

    private final ConnectionFactory connectionFactory;

    public HttpTextClient() {
        this(uri -> (HttpURLConnection) uri.toURL().openConnection());
    }

    HttpTextClient(ConnectionFactory connectionFactory) {
        this.connectionFactory = connectionFactory;
    }

    public FetchResult fetchText(
        String urlString,
        Map<String, String> headers,
        int maxBytes,
        int timeoutMs
    ) throws IOException {
        URI currentUri = parseAndValidateHttpsUri(urlString);
        int effectiveMaxBytes = clampMaxBytes(maxBytes);
        int effectiveTimeoutMs = clampTimeoutMs(timeoutMs);

        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            HttpURLConnection conn = connectionFactory.open(currentUri);
            boolean keepOpenForBody = false;
            try {
                conn.setInstanceFollowRedirects(false);
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(effectiveTimeoutMs);
                conn.setReadTimeout(effectiveTimeoutMs);
                conn.setUseCaches(false);
                conn.setDoInput(true);
                applyAllowedHeaders(conn, headers);

                int status = conn.getResponseCode();
                if (isRedirectStatus(status)) {
                    String location = conn.getHeaderField("Location");
                    if (location == null || location.trim().isEmpty()) {
                        throw new IOException("Redirect response missing Location header.");
                    }
                    URI nextUri = currentUri.resolve(location.trim());
                    validateHttpsUri(nextUri);
                    currentUri = nextUri;
                    continue;
                }

                keepOpenForBody = true;
                return readTextResponse(conn, status, currentUri.toString(), effectiveMaxBytes);
            } finally {
                if (!keepOpenForBody) {
                    conn.disconnect();
                }
            }
        }

        throw new IOException("Too many redirects (max " + MAX_REDIRECTS + ").");
    }

    private FetchResult readTextResponse(
        HttpURLConnection conn,
        int status,
        String finalUrl,
        int maxBytes
    ) throws IOException {
        try (InputStream stream = openResponseStream(conn, status)) {
            if (stream == null) {
                return new FetchResult(status, finalUrl, "", false);
            }
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[Math.min(READ_BUFFER_BYTES, maxBytes)];
            int remaining = maxBytes;
            boolean truncated = false;

            while (remaining > 0) {
                int toRead = Math.min(chunk.length, remaining);
                int read = stream.read(chunk, 0, toRead);
                if (read == -1) {
                    break;
                }
                buffer.write(chunk, 0, read);
                remaining -= read;
            }

            if (remaining == 0 && stream.read() != -1) {
                truncated = true;
            }

            String text = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
            return new FetchResult(status, finalUrl, text, truncated);
        } finally {
            conn.disconnect();
        }
    }

    private static InputStream openResponseStream(HttpURLConnection conn, int status)
        throws IOException {
        if (status >= 400) {
            return conn.getErrorStream();
        }
        try {
            return conn.getInputStream();
        } catch (IOException err) {
            InputStream errorStream = conn.getErrorStream();
            if (errorStream != null) {
                return errorStream;
            }
            throw err;
        }
    }

    private static URI parseAndValidateHttpsUri(String urlString) {
        if (urlString == null || urlString.trim().isEmpty()) {
            throw new IllegalArgumentException("URL must not be empty.");
        }
        URI uri = URI.create(urlString.trim());
        validateHttpsUri(uri);
        return uri;
    }

    private static void validateHttpsUri(URI uri) {
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(scheme) || host == null || host.trim().isEmpty()) {
            throw new IllegalArgumentException("Only strict https:// URLs are allowed.");
        }
    }

    private static void applyAllowedHeaders(HttpURLConnection conn, Map<String, String> headers) {
        if (headers == null || headers.isEmpty()) {
            return;
        }
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            String key = entry.getKey();
            String value = entry.getValue();
            if (key == null || value == null) {
                continue;
            }
            String trimmedKey = key.trim();
            if (!ALLOWED_HEADERS.contains(trimmedKey.toLowerCase(Locale.ROOT))) {
                continue;
            }
            String sanitizedValue = value.replace("\r", "").replace("\n", "");
            conn.setRequestProperty(trimmedKey, sanitizedValue);
        }
    }

    private static boolean isRedirectStatus(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    private static int clampMaxBytes(int maxBytes) {
        if (maxBytes <= 0) {
            return MAX_BYTES_CAP;
        }
        return Math.min(maxBytes, MAX_BYTES_CAP);
    }

    private static int clampTimeoutMs(int timeoutMs) {
        if (timeoutMs <= 0) {
            return DEFAULT_TIMEOUT_MS;
        }
        return Math.min(timeoutMs, MAX_TIMEOUT_MS);
    }
}
