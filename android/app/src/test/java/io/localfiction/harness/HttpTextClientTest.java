package io.localfiction.harness;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class HttpTextClientTest {

    private static final class StubHttpURLConnection extends HttpURLConnection {
        private final int responseCode;
        private final byte[] body;
        private final byte[] errorBody;
        private final Map<String, String> responseHeaders = new LinkedHashMap<>();
        final Map<String, String> capturedRequestHeaders = new LinkedHashMap<>();
        boolean instanceFollowRedirects = true;
        int connectTimeoutMs;
        int readTimeoutMs;
        boolean disconnected;

        StubHttpURLConnection(URL url, int responseCode, byte[] body) {
            this(url, responseCode, body, null);
        }

        StubHttpURLConnection(URL url, int responseCode, byte[] body, byte[] errorBody) {
            super(url);
            this.responseCode = responseCode;
            this.body = body;
            this.errorBody = errorBody;
        }

        StubHttpURLConnection withHeader(String name, String value) {
            responseHeaders.put(name, value);
            return this;
        }

        @Override
        public void setInstanceFollowRedirects(boolean followRedirects) {
            this.instanceFollowRedirects = followRedirects;
            super.setInstanceFollowRedirects(followRedirects);
        }

        @Override
        public void setConnectTimeout(int timeout) {
            this.connectTimeoutMs = timeout;
        }

        @Override
        public void setReadTimeout(int timeout) {
            this.readTimeoutMs = timeout;
        }

        @Override
        public void setRequestProperty(String key, String value) {
            capturedRequestHeaders.put(key, value);
        }

        @Override
        public int getResponseCode() {
            return responseCode;
        }

        @Override
        public String getHeaderField(String name) {
            for (Map.Entry<String, String> entry : responseHeaders.entrySet()) {
                if (entry.getKey().equalsIgnoreCase(name)) {
                    return entry.getValue();
                }
            }
            return null;
        }

        @Override
        public InputStream getInputStream() throws IOException {
            if (responseCode >= 400) {
                throw new IOException("HTTP " + responseCode);
            }
            return new ByteArrayInputStream(body != null ? body : new byte[0]);
        }

        @Override
        public InputStream getErrorStream() {
            return errorBody != null ? new ByteArrayInputStream(errorBody) : null;
        }

        @Override
        public void disconnect() {
            disconnected = true;
        }

        @Override
        public boolean usingProxy() {
            return false;
        }

        @Override
        public void connect() {}
    }

    @Test
    public void rejectsNonHttpsAndMalformedUrls() {
        HttpTextClient client = new HttpTextClient();
        assertThrows(IllegalArgumentException.class, () ->
            client.fetchText("http://example.com/page", null, 1024, 5000)
        );
        assertThrows(IllegalArgumentException.class, () ->
            client.fetchText("file:///etc/passwd", null, 1024, 5000)
        );
        assertThrows(IllegalArgumentException.class, () ->
            client.fetchText("", null, 1024, 5000)
        );
        assertThrows(IllegalArgumentException.class, () ->
            client.fetchText(null, null, 1024, 5000)
        );
        assertThrows(IllegalArgumentException.class, () ->
            client.fetchText("not a valid url", null, 1024, 5000)
        );
    }

    @Test
    public void forwardsOnlyAllowlistedHeadersAndDropsCredentials() throws Exception {
        List<StubHttpURLConnection> opened = new ArrayList<>();
        HttpTextClient client = new HttpTextClient(uri -> {
            StubHttpURLConnection conn = new StubHttpURLConnection(
                uri.toURL(),
                200,
                "你好世界".getBytes(StandardCharsets.UTF_8)
            );
            opened.add(conn);
            return conn;
        });

        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("accept", "text/html");
        headers.put("Accept-Language", "zh-CN,zh;q=0.9");
        headers.put("user-agent", "FolioTest/1.0");
        headers.put("Authorization", "Bearer secret-key");
        headers.put("Cookie", "session=abc");
        headers.put("X-Api-Key", "sk-12345");
        headers.put("X-Custom-Header", "nope");

        HttpTextClient.FetchResult result = client.fetchText(
            "https://example.com/article",
            headers,
            0,
            0
        );

        assertEquals(200, result.status);
        assertEquals("https://example.com/article", result.finalUrl);
        assertEquals("你好世界", result.text);
        assertFalse(result.truncated);

        StubHttpURLConnection conn = opened.get(0);
        assertFalse(conn.instanceFollowRedirects);
        assertEquals(8_000, conn.connectTimeoutMs);
        assertEquals(8_000, conn.readTimeoutMs);
        assertEquals("text/html", conn.capturedRequestHeaders.get("accept"));
        assertEquals("zh-CN,zh;q=0.9", conn.capturedRequestHeaders.get("Accept-Language"));
        assertEquals("FolioTest/1.0", conn.capturedRequestHeaders.get("user-agent"));
        assertNull(conn.capturedRequestHeaders.get("Authorization"));
        assertNull(conn.capturedRequestHeaders.get("Cookie"));
        assertNull(conn.capturedRequestHeaders.get("X-Api-Key"));
        assertNull(conn.capturedRequestHeaders.get("X-Custom-Header"));
    }

    @Test
    public void followsUpToThreeHttpsRedirectsAndRejectsUnsafeOrExcessiveRedirects() throws Exception {
        HttpTextClient client = new HttpTextClient(uri -> {
            String path = uri.getPath();
            if ("/hop0".equals(path)) {
                return new StubHttpURLConnection(uri.toURL(), 302, new byte[0])
                    .withHeader("Location", "/hop1");
            }
            if ("/hop1".equals(path)) {
                return new StubHttpURLConnection(uri.toURL(), 301, new byte[0])
                    .withHeader("Location", "https://example.org/hop2");
            }
            if ("/hop2".equals(path)) {
                return new StubHttpURLConnection(uri.toURL(), 307, new byte[0])
                    .withHeader("Location", "/hop3");
            }
            if ("/hop3".equals(path)) {
                return new StubHttpURLConnection(
                    uri.toURL(),
                    200,
                    "final".getBytes(StandardCharsets.UTF_8)
                );
            }
            if ("/to-http".equals(path)) {
                return new StubHttpURLConnection(uri.toURL(), 302, new byte[0])
                    .withHeader("Location", "http://insecure.example.com/target");
            }
            return new StubHttpURLConnection(uri.toURL(), 302, new byte[0])
                .withHeader("Location", "/loop");
        });

        HttpTextClient.FetchResult ok = client.fetchText("https://example.com/hop0", null, 1024, 5000);
        assertEquals(200, ok.status);
        assertEquals("https://example.org/hop3", ok.finalUrl);
        assertEquals("final", ok.text);

        assertThrows(IllegalArgumentException.class, () ->
            client.fetchText("https://example.com/to-http", null, 1024, 5000)
        );
        assertThrows(IOException.class, () ->
            client.fetchText("https://example.com/loop", null, 1024, 5000)
        );
    }

    @Test
    public void capsTimeoutAndMaxBytesAndMarksTruncatedReads() throws Exception {
        List<StubHttpURLConnection> opened = new ArrayList<>();
        byte[] largePayload = new byte[600 * 1024];
        for (int i = 0; i < largePayload.length; i++) {
            largePayload[i] = 'a';
        }
        HttpTextClient client = new HttpTextClient(uri -> {
            StubHttpURLConnection conn = new StubHttpURLConnection(
                uri.toURL(),
                200,
                largePayload
            );
            opened.add(conn);
            return conn;
        });

        HttpTextClient.FetchResult capped = client.fetchText(
            "https://example.com/large",
            null,
            1024 * 1024,
            30_000
        );
        assertTrue(capped.truncated);
        assertEquals(512 * 1024, capped.text.length());
        assertEquals(10_000, opened.get(0).connectTimeoutMs);
        assertEquals(10_000, opened.get(0).readTimeoutMs);

        HttpTextClient.FetchResult small = client.fetchText(
            "https://example.com/large",
            null,
            10,
            2000
        );
        assertTrue(small.truncated);
        assertEquals("aaaaaaaaaa", small.text);
    }

    @Test
    public void readsErrorStreamOnNon2xxStatus() throws Exception {
        HttpTextClient client = new HttpTextClient(uri ->
            new StubHttpURLConnection(
                uri.toURL(),
                404,
                null,
                "Not Found".getBytes(StandardCharsets.UTF_8)
            )
        );

        HttpTextClient.FetchResult res = client.fetchText("https://example.com/404", null, 1024, 3000);
        assertEquals(404, res.status);
        assertEquals("Not Found", res.text);
        assertFalse(res.truncated);
    }
}
