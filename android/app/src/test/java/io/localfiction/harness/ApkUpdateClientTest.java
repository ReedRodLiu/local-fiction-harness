package io.localfiction.harness;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class ApkUpdateClientTest {
    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final class HttpRequest {
        final String path;
        final String rawHeaders;

        HttpRequest(String path, String rawHeaders) {
            this.path = path;
            this.rawHeaders = rawHeaders;
        }
    }

    private static HttpRequest readHttpRequest(Socket socket) throws Exception {
        InputStream in = socket.getInputStream();
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int prev = -1;
        int cur;
        while ((cur = in.read()) != -1) {
            buf.write(cur);
            String s = buf.toString(StandardCharsets.US_ASCII);
            if (s.endsWith("\r\n\r\n")) {
                String firstLine = s.split("\r\n")[0];
                String[] parts = firstLine.split(" ");
                String path = parts.length >= 2 ? parts[1] : "/";
                return new HttpRequest(path, s);
            }
            if (buf.size() > 8192 || (prev == '\n' && cur == '\n')) break;
            prev = cur;
        }
        return new HttpRequest("/", buf.toString(StandardCharsets.US_ASCII));
    }

    private static byte[] buildSampleApkBytes(int totalSize) {
        byte[] bytes = new byte[Math.max(16, totalSize)];
        bytes[0] = 0x50;
        bytes[1] = 0x4b;
        bytes[2] = 0x03;
        bytes[3] = 0x04;
        for (int i = 4; i < bytes.length; i++) {
            bytes[i] = (byte) ((i * 31 + 7) & 0xFF);
        }
        return bytes;
    }

    private static String sha256Hex(byte[] data) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] digest = md.digest(data);
        StringBuilder sb = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    @Test
    public void buildApkFileNameSanitizesAndPreventsTraversal() {
        assertEquals("Folio-v1.2.3.apk", ApkUpdateClient.buildApkFileName("1.2.3"));
        assertEquals("Folio-v1.2.3.apk", ApkUpdateClient.buildApkFileName("v1.2.3"));
        assertEquals("Folio-v1.2.3-beta_1.apk", ApkUpdateClient.buildApkFileName("V1.2.3-beta+1"));
        assertEquals("Folio-vunknown.apk", ApkUpdateClient.buildApkFileName(""));
        assertEquals("Folio-vunknown.apk", ApkUpdateClient.buildApkFileName(null));
        assertEquals("Folio-vunknown.apk", ApkUpdateClient.buildApkFileName("v"));
        String traversal = ApkUpdateClient.buildApkFileName("../../etc/passwd");
        assertFalse(traversal.contains(".."));
        assertFalse(traversal.contains("/"));
        assertFalse(traversal.contains("\\"));
        assertTrue(traversal.startsWith("Folio-v"));
        assertTrue(traversal.endsWith(".apk"));
    }

    @Test
    public void fetchJsonRejectsNonHttpsInProdMode() throws Exception {
        ApkUpdateClient prodClient = new ApkUpdateClient();
        try {
            try {
                prodClient.fetchJson("http://api.github.com/repos/example/releases", 1024 * 1024);
                fail("Expected IllegalArgumentException for http:// in prod mode");
            } catch (IllegalArgumentException expected) {
                assertTrue(expected.getMessage().contains("HTTPS"));
            }

            CountDownLatch latch = new CountDownLatch(1);
            AtomicReference<String> errCode = new AtomicReference<>();
            AtomicReference<String> errMsg = new AtomicReference<>();
            File updatesDir = tempFolder.newFolder("prod-updates");

            prodClient.downloadAndVerifyApk(
                "req-http",
                "http://github.com/example/app.apk",
                updatesDir,
                "1.0.0",
                null,
                10 * 1024 * 1024,
                null,
                new ApkUpdateClient.Listener() {
                    @Override
                    public void onProgress(String requestId, long downloadedBytes, long totalBytes) {}

                    @Override
                    public void onComplete(
                        String requestId,
                        String fileName,
                        String version,
                        String sha256,
                        long sizeBytes,
                        boolean reusedCache
                    ) {
                        latch.countDown();
                    }

                    @Override
                    public void onError(String requestId, int status, String code, String message, boolean aborted) {
                        errCode.set(code);
                        errMsg.set(message);
                        latch.countDown();
                    }
                }
            );
            assertTrue(latch.await(5, TimeUnit.SECONDS));
            assertEquals("INVALID_URL", errCode.get());
            assertTrue(errMsg.get().contains("HTTPS"));
        } finally {
            prodClient.shutdown();
        }
    }

    @Test
    public void fetchJsonSuccessHttpErrorsRedirectsAndMaxBytes() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))) {
            AtomicReference<String> capturedHeaders = new AtomicReference<>();
            Thread serverThread = new Thread(() -> {
                for (int i = 0; i < 6; i++) {
                    try (Socket conn = server.accept()) {
                        HttpRequest req = readHttpRequest(conn);
                        OutputStream os = conn.getOutputStream();
                        if ("/releases.json".equals(req.path)) {
                            capturedHeaders.set(req.rawHeaders);
                            byte[] body = "[{\"tag_name\":\"v0.4.0\"}]".getBytes(StandardCharsets.UTF_8);
                            os.write((
                                "HTTP/1.1 200 OK\r\n"
                                    + "Content-Type: application/json\r\n"
                                    + "Content-Length: " + body.length + "\r\n"
                                    + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.write(body);
                            os.flush();
                        } else if ("/redirect-untrusted".equals(req.path)) {
                            os.write((
                                "HTTP/1.1 302 Found\r\n"
                                    + "Location: http://untrusted.example.invalid/releases.json\r\n"
                                    + "Content-Length: 0\r\n"
                                    + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.flush();
                        } else if ("/rate-limited".equals(req.path)) {
                            os.write((
                                "HTTP/1.1 403 Forbidden\r\n"
                                    + "Content-Length: 0\r\n"
                                    + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.flush();
                        } else if ("/not-found".equals(req.path)) {
                            os.write((
                                "HTTP/1.1 404 Not Found\r\n"
                                    + "Content-Length: 0\r\n"
                                    + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.flush();
                        } else if ("/large-declared.json".equals(req.path)) {
                            byte[] body = "{\"data\":\"0123456789abcdef\"}".getBytes(StandardCharsets.UTF_8);
                            os.write((
                                "HTTP/1.1 200 OK\r\n"
                                    + "Content-Type: application/json\r\n"
                                    + "Content-Length: " + body.length + "\r\n"
                                    + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.write(body);
                            os.flush();
                        } else if ("/large-stream.json".equals(req.path)) {
                            os.write((
                                "HTTP/1.1 200 OK\r\n"
                                    + "Content-Type: application/json\r\n"
                                    + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.write("{\"data\":\"0123456789abcdef0123456789\"}".getBytes(StandardCharsets.UTF_8));
                            os.flush();
                        }
                    } catch (Exception ignored) {
                    }
                }
            });
            serverThread.start();

            ApkUpdateClient client = new ApkUpdateClient(true);
            try {
                String base = "http://127.0.0.1:" + server.getLocalPort();

                String json = client.fetchJson(base + "/releases.json", 4096);
                assertEquals("[{\"tag_name\":\"v0.4.0\"}]", json);
                assertTrue(capturedHeaders.get().contains("Accept: application/json"));
                assertTrue(capturedHeaders.get().contains("User-Agent: Folio-Android"));

                try {
                    client.fetchJson(base + "/redirect-untrusted", 4096);
                    fail("Expected redirect to non-loopback HTTP to be rejected");
                } catch (IllegalArgumentException expected) {
                    assertTrue(expected.getMessage().contains("HTTPS"));
                }

                try {
                    client.fetchJson(base + "/rate-limited", 4096);
                    fail("Expected HttpStatusException for 403");
                } catch (ApkUpdateClient.HttpStatusException expected) {
                    assertEquals(403, expected.getStatus());
                    assertTrue(expected.getMessage().toLowerCase(Locale.ROOT).contains("rate-limit"));
                }

                try {
                    client.fetchJson(base + "/not-found", 4096);
                    fail("Expected HttpStatusException for 404");
                } catch (ApkUpdateClient.HttpStatusException expected) {
                    assertEquals(404, expected.getStatus());
                }

                try {
                    client.fetchJson(base + "/large-declared.json", 10);
                    fail("Expected IOException for declared maxBytes limit");
                } catch (IOException expected) {
                    assertTrue(expected.getMessage().contains("maxBytes"));
                }

                try {
                    client.fetchJson(base + "/large-stream.json", 10);
                    fail("Expected IOException for streamed maxBytes limit");
                } catch (IOException expected) {
                    assertTrue(expected.getMessage().contains("maxBytes"));
                }
            } finally {
                client.shutdown();
            }
            serverThread.join(3000);
        }
    }

    @Test
    public void downloadVerifyCacheReuseAndInvalidation() throws Exception {
        byte[] apkBytes = buildSampleApkBytes(200 * 1024);
        String expectedShaUpper = sha256Hex(apkBytes).toUpperCase(Locale.ROOT);
        AtomicInteger serverHits = new AtomicInteger(0);

        try (ServerSocket server = new ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))) {
            Thread serverThread = new Thread(() -> {
                // Only 2 HTTP downloads should happen: initial download + after cache corruption.
                for (int i = 0; i < 2; i++) {
                    try (Socket conn = server.accept()) {
                        HttpRequest req = readHttpRequest(conn);
                        if ("/app.apk".equals(req.path)) {
                            serverHits.incrementAndGet();
                            OutputStream os = conn.getOutputStream();
                            os.write((
                                "HTTP/1.1 200 OK\r\n"
                                    + "Content-Type: application/vnd.android.package-archive\r\n"
                                    + "Content-Length: " + apkBytes.length + "\r\n"
                                    + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.write(apkBytes);
                            os.flush();
                        }
                    } catch (Exception ignored) {
                    }
                }
            });
            serverThread.start();

            File updatesDir = tempFolder.newFolder("updates");
            ApkUpdateClient client = new ApkUpdateClient(true);
            try {
                String url = "http://127.0.0.1:" + server.getLocalPort() + "/app.apk";

                // 1. Fresh download
                CountDownLatch latch1 = new CountDownLatch(1);
                List<Long> progressBytes = new ArrayList<>();
                AtomicReference<String> fileName1 = new AtomicReference<>();
                AtomicReference<String> sha1 = new AtomicReference<>();
                AtomicLongSize size1 = new AtomicLongSize();
                AtomicBoolean reused1 = new AtomicBoolean(true);

                client.downloadAndVerifyApk(
                    "dl-1",
                    url,
                    updatesDir,
                    "v0.4.0",
                    expectedShaUpper,
                    1024 * 1024,
                    file -> ApkUpdateClient.VerificationResult.ok(),
                    new ApkUpdateClient.Listener() {
                        @Override
                        public void onProgress(String requestId, long downloadedBytes, long totalBytes) {
                            assertEquals(apkBytes.length, totalBytes);
                            progressBytes.add(downloadedBytes);
                        }

                        @Override
                        public void onComplete(
                            String requestId,
                            String fileName,
                            String version,
                            String sha256,
                            long sizeBytes,
                            boolean reusedCache
                        ) {
                            fileName1.set(fileName);
                            sha1.set(sha256);
                            size1.value = sizeBytes;
                            reused1.set(reusedCache);
                            latch1.countDown();
                        }

                        @Override
                        public void onError(String requestId, int status, String code, String message, boolean aborted) {
                            fail("Unexpected error: " + code + " - " + message);
                        }
                    }
                );

                assertTrue(latch1.await(5, TimeUnit.SECONDS));
                assertEquals("Folio-v0.4.0.apk", fileName1.get());
                assertEquals(expectedShaUpper.toLowerCase(Locale.ROOT), sha1.get());
                assertEquals(apkBytes.length, size1.value);
                assertFalse(reused1.get());
                assertFalse(progressBytes.isEmpty());
                assertEquals(apkBytes.length, (long) progressBytes.get(progressBytes.size() - 1));
                assertEquals(1, serverHits.get());

                File cachedFile = new File(updatesDir, "Folio-v0.4.0.apk");
                assertTrue(cachedFile.isFile());
                assertArrayEquals(apkBytes, Files.readAllBytes(cachedFile.toPath()));
                assertFalse(new File(updatesDir, "Folio-v0.4.0.apk.part").exists());

                // 2. Second call should reuse cache without hitting server
                CountDownLatch latch2 = new CountDownLatch(1);
                AtomicBoolean reused2 = new AtomicBoolean(false);
                client.downloadAndVerifyApk(
                    "dl-2",
                    url,
                    updatesDir,
                    "0.4.0",
                    expectedShaUpper,
                    1024 * 1024,
                    file -> ApkUpdateClient.VerificationResult.ok(),
                    new ApkUpdateClient.Listener() {
                        @Override
                        public void onProgress(String requestId, long downloadedBytes, long totalBytes) {}

                        @Override
                        public void onComplete(
                            String requestId,
                            String fileName,
                            String version,
                            String sha256,
                            long sizeBytes,
                            boolean reusedCache
                        ) {
                            reused2.set(reusedCache);
                            latch2.countDown();
                        }

                        @Override
                        public void onError(String requestId, int status, String code, String message, boolean aborted) {
                            fail("Unexpected error: " + code + " - " + message);
                        }
                    }
                );
                assertTrue(latch2.await(5, TimeUnit.SECONDS));
                assertTrue(reused2.get());
                assertEquals(1, serverHits.get());

                // 3. Corrupt cache and verify it invalidates and re-downloads
                try (FileOutputStream fos = new FileOutputStream(cachedFile)) {
                    fos.write(new byte[] { 0x50, 0x4b, 0x03, 0x04, 0x7f, 0x7f });
                }

                CountDownLatch latch3 = new CountDownLatch(1);
                AtomicBoolean reused3 = new AtomicBoolean(true);
                client.downloadAndVerifyApk(
                    "dl-3",
                    url,
                    updatesDir,
                    "v0.4.0",
                    expectedShaUpper,
                    1024 * 1024,
                    file -> ApkUpdateClient.VerificationResult.ok(),
                    new ApkUpdateClient.Listener() {
                        @Override
                        public void onProgress(String requestId, long downloadedBytes, long totalBytes) {}

                        @Override
                        public void onComplete(
                            String requestId,
                            String fileName,
                            String version,
                            String sha256,
                            long sizeBytes,
                            boolean reusedCache
                        ) {
                            reused3.set(reusedCache);
                            latch3.countDown();
                        }

                        @Override
                        public void onError(String requestId, int status, String code, String message, boolean aborted) {
                            fail("Unexpected error: " + code + " - " + message);
                        }
                    }
                );
                assertTrue(latch3.await(5, TimeUnit.SECONDS));
                assertFalse(reused3.get());
                assertEquals(2, serverHits.get());
                assertArrayEquals(apkBytes, Files.readAllBytes(cachedFile.toPath()));
            } finally {
                client.shutdown();
            }
            serverThread.join(3000);
        }
    }

    @Test
    public void downloadRejectsShaMismatchSignatureMismatchHtmlAndSupportsAbort() throws Exception {
        byte[] apkBytes = buildSampleApkBytes(1024);
        String validSha = sha256Hex(apkBytes);
        CountDownLatch slowStarted = new CountDownLatch(1);

        try (ServerSocket server = new ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))) {
            Thread serverThread = new Thread(() -> {
                for (int i = 0; i < 4; i++) {
                    try (Socket conn = server.accept()) {
                        HttpRequest req = readHttpRequest(conn);
                        OutputStream os = conn.getOutputStream();
                        if ("/apk".equals(req.path)) {
                            os.write((
                                "HTTP/1.1 200 OK\r\n"
                                    + "Content-Length: " + apkBytes.length + "\r\n"
                                    + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.write(apkBytes);
                            os.flush();
                        } else if ("/html".equals(req.path)) {
                            byte[] html = "<!DOCTYPE html><html><body>404</body></html>".getBytes(StandardCharsets.UTF_8);
                            os.write((
                                "HTTP/1.1 200 OK\r\n"
                                    + "Content-Type: text/html\r\n"
                                    + "Content-Length: " + html.length + "\r\n"
                                    + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.write(html);
                            os.flush();
                        } else if ("/slow".equals(req.path)) {
                            os.write((
                                "HTTP/1.1 200 OK\r\n"
                                    + "Content-Type: application/vnd.android.package-archive\r\n"
                                    + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.write(apkBytes, 0, 16);
                            os.flush();
                            slowStarted.countDown();
                            Thread.sleep(5000);
                        }
                    } catch (Exception ignored) {
                    }
                }
            });
            serverThread.start();

            File updatesDir = tempFolder.newFolder("updates-err");
            ApkUpdateClient client = new ApkUpdateClient(true);
            String base = "http://127.0.0.1:" + server.getLocalPort();

            try {
                // 1. SHA-256 mismatch
                CountDownLatch shaLatch = new CountDownLatch(1);
                AtomicReference<String> shaErrCode = new AtomicReference<>();
                client.downloadAndVerifyApk(
                    "req-sha",
                    base + "/apk",
                    updatesDir,
                    "1.0.1",
                    "0000000000000000000000000000000000000000000000000000000000000000",
                    1024 * 1024,
                    null,
                    errorOnlyListener(shaErrCode, new AtomicBoolean(), shaLatch)
                );
                assertTrue(shaLatch.await(5, TimeUnit.SECONDS));
                assertEquals("SHA256_MISMATCH", shaErrCode.get());
                assertFalse(new File(updatesDir, "Folio-v1.0.1.apk").exists());
                assertFalse(new File(updatesDir, "Folio-v1.0.1.apk.part").exists());

                // 2. Signature mismatch from ApkVerifier
                CountDownLatch sigLatch = new CountDownLatch(1);
                AtomicReference<String> sigErrCode = new AtomicReference<>();
                client.downloadAndVerifyApk(
                    "req-sig",
                    base + "/apk",
                    updatesDir,
                    "1.0.2",
                    validSha,
                    1024 * 1024,
                    file -> ApkUpdateClient.VerificationResult.fail("SIGNATURE_MISMATCH", "Cert mismatch"),
                    errorOnlyListener(sigErrCode, new AtomicBoolean(), sigLatch)
                );
                assertTrue(sigLatch.await(5, TimeUnit.SECONDS));
                assertEquals("SIGNATURE_MISMATCH", sigErrCode.get());
                assertFalse(new File(updatesDir, "Folio-v1.0.2.apk").exists());
                assertFalse(new File(updatesDir, "Folio-v1.0.2.apk.part").exists());

                // 3. HTML payload
                CountDownLatch htmlLatch = new CountDownLatch(1);
                AtomicReference<String> htmlErrCode = new AtomicReference<>();
                client.downloadAndVerifyApk(
                    "req-html",
                    base + "/html",
                    updatesDir,
                    "1.0.3",
                    null,
                    1024 * 1024,
                    null,
                    errorOnlyListener(htmlErrCode, new AtomicBoolean(), htmlLatch)
                );
                assertTrue(htmlLatch.await(5, TimeUnit.SECONDS));
                assertEquals("INVALID_APK", htmlErrCode.get());
                assertFalse(new File(updatesDir, "Folio-v1.0.3.apk").exists());
                assertFalse(new File(updatesDir, "Folio-v1.0.3.apk.part").exists());

                // 4. Abort in-flight download
                CountDownLatch abortLatch = new CountDownLatch(1);
                AtomicReference<String> abortErrCode = new AtomicReference<>();
                AtomicBoolean abortedFlag = new AtomicBoolean(false);
                client.downloadAndVerifyApk(
                    "req-abort",
                    base + "/slow",
                    updatesDir,
                    "1.0.4",
                    null,
                    1024 * 1024,
                    null,
                    errorOnlyListener(abortErrCode, abortedFlag, abortLatch)
                );
                assertTrue(slowStarted.await(5, TimeUnit.SECONDS));
                assertTrue(client.abortDownload("req-abort"));
                assertTrue(abortLatch.await(5, TimeUnit.SECONDS));
                assertEquals("ABORTED", abortErrCode.get());
                assertTrue(abortedFlag.get());
                assertFalse(new File(updatesDir, "Folio-v1.0.4.apk").exists());
                assertFalse(new File(updatesDir, "Folio-v1.0.4.apk.part").exists());
            } finally {
                client.shutdown();
            }
            serverThread.join(3000);
        }
    }

    @Test
    public void cleanupStaleApksRemovesOldAndPartFilesAndKeepsTarget() throws Exception {
        File updatesDir = tempFolder.newFolder("cleanup");
        File keepFile = new File(updatesDir, ApkUpdateClient.buildApkFileName("v0.5.0"));
        File oldApk = new File(updatesDir, ApkUpdateClient.buildApkFileName("v0.4.0"));
        File partFile = new File(updatesDir, "Folio-v0.5.0.apk.part");

        assertTrue(keepFile.createNewFile());
        assertTrue(oldApk.createNewFile());
        assertTrue(partFile.createNewFile());

        ApkUpdateClient.cleanupStaleApks(updatesDir, "0.5.0");

        assertTrue(keepFile.exists());
        assertFalse(oldApk.exists());
        assertFalse(partFile.exists());

        ApkUpdateClient.cleanupStaleApks(updatesDir, null);
        assertFalse(keepFile.exists());
    }

    private static ApkUpdateClient.Listener errorOnlyListener(
        AtomicReference<String> codeOut,
        AtomicBoolean abortedOut,
        CountDownLatch latch
    ) {
        return new ApkUpdateClient.Listener() {
            @Override
            public void onProgress(String requestId, long downloadedBytes, long totalBytes) {}

            @Override
            public void onComplete(
                String requestId,
                String fileName,
                String version,
                String sha256,
                long sizeBytes,
                boolean reusedCache
            ) {
                fail("Expected error but got onComplete");
                latch.countDown();
            }

            @Override
            public void onError(String requestId, int status, String code, String message, boolean aborted) {
                codeOut.set(code);
                abortedOut.set(aborted);
                latch.countDown();
            }
        };
    }

    private static final class AtomicLongSize {
        long value;
    }
}
