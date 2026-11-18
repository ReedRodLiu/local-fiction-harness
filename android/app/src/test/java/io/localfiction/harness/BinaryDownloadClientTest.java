package io.localfiction.harness;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

public class BinaryDownloadClientTest {
    private static String readHttpPath(Socket socket) throws Exception {
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
                return parts.length >= 2 ? parts[1] : "/";
            }
            if (buf.size() > 8192 || (prev == '\n' && cur == '\n')) break;
            prev = cur;
        }
        return "/";
    }

    @Test
    public void rejectsNonHttpsUrlsAndNonHttpsRedirectsInProductionMode() throws Exception {
        BinaryDownloadClient prodClient = new BinaryDownloadClient();
        try {
            CountDownLatch latch = new CountDownLatch(1);
            AtomicReference<String> errMsg = new AtomicReference<>("");
            prodClient.startDownload("req-http", "http://cdn.deepseek.com/export.zip", 1024 * 1024, new BinaryDownloadClient.Listener() {
                @Override
                public void onChunk(String requestId, byte[] chunk, int length) {}

                @Override
                public void onComplete(String requestId, String contentType) {
                    latch.countDown();
                }

                @Override
                public void onError(String requestId, int status, String message, boolean aborted) {
                    errMsg.set(message);
                    latch.countDown();
                }
            });
            assertTrue(latch.await(5, TimeUnit.SECONDS));
            assertTrue(errMsg.get().contains("HTTPS"));
        } finally {
            prodClient.shutdown();
        }
    }

    @Test
    public void downloadsValidZipRejectsHtmlAndEnforcesMaxBytesAndHttpErrorsAndAbort() throws Exception {
        byte[] validZip = new byte[] { 0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x01, 0x02 };
        CountDownLatch slowStarted = new CountDownLatch(1);

        try (ServerSocket server = new ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))) {
            Thread serverThread = new Thread(() -> {
                for (int i = 0; i < 6; i++) {
                    try (Socket conn = server.accept()) {
                        String path = readHttpPath(conn);
                        OutputStream os = conn.getOutputStream();
                        if ("/valid.zip".equals(path)) {
                            os.write((
                                "HTTP/1.1 200 OK\r\n"
                                + "Content-Type: application/zip\r\n"
                                + "Content-Length: " + validZip.length + "\r\n"
                                + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.write(validZip);
                            os.flush();
                        } else if ("/redirect-http".equals(path)) {
                            os.write((
                                "HTTP/1.1 302 Found\r\n"
                                + "Location: http://untrusted.example.invalid/export.zip\r\n"
                                + "Content-Length: 0\r\n"
                                + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.flush();
                        } else if ("/html".equals(path)) {
                            byte[] html = "<!DOCTYPE html><html><body>Login</body></html>".getBytes(StandardCharsets.UTF_8);
                            os.write((
                                "HTTP/1.1 200 OK\r\n"
                                + "Content-Type: text/html\r\n"
                                + "Content-Length: " + html.length + "\r\n"
                                + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.write(html);
                            os.flush();
                        } else if ("/toobig.zip".equals(path)) {
                            os.write((
                                "HTTP/1.1 200 OK\r\n"
                                + "Content-Type: application/zip\r\n"
                                + "Content-Length: 5000\r\n"
                                + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.write(validZip);
                            os.flush();
                        } else if ("/forbidden".equals(path)) {
                            os.write((
                                "HTTP/1.1 403 Forbidden\r\n"
                                + "Content-Length: 0\r\n"
                                + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.flush();
                        } else {
                            os.write((
                                "HTTP/1.1 200 OK\r\n"
                                + "Content-Type: application/zip\r\n"
                                + "Connection: close\r\n\r\n"
                            ).getBytes(StandardCharsets.US_ASCII));
                            os.write(validZip, 0, 4);
                            os.flush();
                            slowStarted.countDown();
                            Thread.sleep(5000);
                        }
                    } catch (Exception ignored) {
                    }
                }
            });
            serverThread.setDaemon(true);
            serverThread.start();

            BinaryDownloadClient client = new BinaryDownloadClient(true);
            String baseUrl = "http://127.0.0.1:" + server.getLocalPort();
            try {
                // 1. Valid ZIP
                CountDownLatch okLatch = new CountDownLatch(1);
                ByteArrayOutputStream collected = new ByteArrayOutputStream();
                AtomicReference<String> okType = new AtomicReference<>("");
                client.startDownload("d-ok", baseUrl + "/valid.zip", 1024, new BinaryDownloadClient.Listener() {
                    @Override
                    public void onChunk(String requestId, byte[] chunk, int length) {
                        collected.write(chunk, 0, length);
                    }

                    @Override
                    public void onComplete(String requestId, String contentType) {
                        okType.set(contentType);
                        okLatch.countDown();
                    }

                    @Override
                    public void onError(String requestId, int status, String message, boolean aborted) {
                        okLatch.countDown();
                    }
                });
                assertTrue(okLatch.await(5, TimeUnit.SECONDS));
                assertArrayEquals(validZip, collected.toByteArray());
                assertEquals("application/zip", okType.get());

                // 2. HTML login page rejected by PK magic check
                CountDownLatch htmlLatch = new CountDownLatch(1);
                AtomicReference<String> htmlErr = new AtomicReference<>("");
                client.startDownload("d-html", baseUrl + "/html", 1024, new BinaryDownloadClient.Listener() {
                    @Override
                    public void onChunk(String requestId, byte[] chunk, int length) {}

                    @Override
                    public void onComplete(String requestId, String contentType) {
                        htmlLatch.countDown();
                    }

                    @Override
                    public void onError(String requestId, int status, String message, boolean aborted) {
                        htmlErr.set(message);
                        htmlLatch.countDown();
                    }
                });
                assertTrue(htmlLatch.await(5, TimeUnit.SECONDS));
                assertTrue(htmlErr.get().contains("HTML") || htmlErr.get().contains("PK"));

                // 3. Too big rejected before reading body
                CountDownLatch bigLatch = new CountDownLatch(1);
                AtomicReference<String> bigErr = new AtomicReference<>("");
                client.startDownload("d-big", baseUrl + "/toobig.zip", 100, new BinaryDownloadClient.Listener() {
                    @Override
                    public void onChunk(String requestId, byte[] chunk, int length) {}

                    @Override
                    public void onComplete(String requestId, String contentType) {
                        bigLatch.countDown();
                    }

                    @Override
                    public void onError(String requestId, int status, String message, boolean aborted) {
                        bigErr.set(message);
                        bigLatch.countDown();
                    }
                });
                assertTrue(bigLatch.await(5, TimeUnit.SECONDS));
                assertTrue(bigErr.get().contains("上限"));

                // 4. HTTP 403 error
                CountDownLatch errLatch = new CountDownLatch(1);
                AtomicInteger errStatus = new AtomicInteger();
                client.startDownload("d-403", baseUrl + "/forbidden", 1024, new BinaryDownloadClient.Listener() {
                    @Override
                    public void onChunk(String requestId, byte[] chunk, int length) {}

                    @Override
                    public void onComplete(String requestId, String contentType) {
                        errLatch.countDown();
                    }

                    @Override
                    public void onError(String requestId, int status, String message, boolean aborted) {
                        errStatus.set(status);
                        errLatch.countDown();
                    }
                });
                assertTrue(errLatch.await(5, TimeUnit.SECONDS));
                assertEquals(403, errStatus.get());

                // 5. Redirect to non-loopback HTTP rejected (run before slow test so serverThread isn't sleeping)
                CountDownLatch redirLatch = new CountDownLatch(1);
                AtomicReference<String> redirErr = new AtomicReference<>("");
                client.startDownload("d-redir", baseUrl + "/redirect-http", 1024, new BinaryDownloadClient.Listener() {
                    @Override
                    public void onChunk(String requestId, byte[] chunk, int length) {}

                    @Override
                    public void onComplete(String requestId, String contentType) {
                        redirLatch.countDown();
                    }

                    @Override
                    public void onError(String requestId, int status, String message, boolean aborted) {
                        redirErr.set(message);
                        redirLatch.countDown();
                    }
                });
                assertTrue(redirLatch.await(5, TimeUnit.SECONDS));
                assertTrue(redirErr.get().contains("HTTPS"));

                // 6. Mid-stream abort
                CountDownLatch abortLatch = new CountDownLatch(1);
                AtomicBoolean wasAborted = new AtomicBoolean(false);
                client.startDownload("d-abort", baseUrl + "/slow.zip", 1024, new BinaryDownloadClient.Listener() {
                    @Override
                    public void onChunk(String requestId, byte[] chunk, int length) {}

                    @Override
                    public void onComplete(String requestId, String contentType) {
                        abortLatch.countDown();
                    }

                    @Override
                    public void onError(String requestId, int status, String message, boolean aborted) {
                        wasAborted.set(aborted);
                        abortLatch.countDown();
                    }
                });
                assertTrue(slowStarted.await(5, TimeUnit.SECONDS));
                assertTrue(client.abortDownload("d-abort"));
                assertTrue(abortLatch.await(5, TimeUnit.SECONDS));
                assertTrue(wasAborted.get());
            } finally {
                client.shutdown();
            }
        }
    }
}
