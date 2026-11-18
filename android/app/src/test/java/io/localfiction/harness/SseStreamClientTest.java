package io.localfiction.harness;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

public class SseStreamClientTest {
    private static String readRequestPath(Socket socket) throws Exception {
        BufferedReader reader = new BufferedReader(
            new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8)
        );
        String requestLine = reader.readLine();
        int contentLength = 0;
        String line;
        while ((line = reader.readLine()) != null && !line.isEmpty()) {
            if (line.toLowerCase().startsWith("content-length:")) {
                contentLength = Integer.parseInt(line.substring("content-length:".length()).trim());
            }
        }
        char[] body = new char[contentLength];
        int offset = 0;
        while (offset < contentLength) {
            int n = reader.read(body, offset, contentLength - offset);
            if (n < 0) break;
            offset += n;
        }
        if (requestLine == null) return "/";
        String[] parts = requestLine.split(" ");
        return parts.length >= 2 ? parts[1] : "/";
    }

    @Test
    public void streamsChunksIncrementallyWithoutFullBodyBuffering() throws Exception {
        CountDownLatch firstChunkReceived = new CountDownLatch(1);
        CountDownLatch completed = new CountDownLatch(1);
        List<String> chunks = new CopyOnWriteArrayList<>();

        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            Thread serverThread = new Thread(() -> {
                try (Socket conn = server.accept()) {
                    readRequestPath(conn);
                    OutputStream os = conn.getOutputStream();
                    os.write(
                        (
                            "HTTP/1.1 200 OK\r\n"
                                + "Content-Type: text/event-stream; charset=utf-8\r\n"
                                + "Connection: close\r\n\r\n"
                        ).getBytes(StandardCharsets.UTF_8)
                    );
                    os.write(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"第一块\"}}]}\n\n"
                            .getBytes(StandardCharsets.UTF_8)
                    );
                    os.flush();
                    // Hold stream open until client receives chunk 1 to prove non-buffering
                    firstChunkReceived.await(5, TimeUnit.SECONDS);
                    os.write(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"第二块\"}}]}\n\ndata: [DONE]\n\n"
                            .getBytes(StandardCharsets.UTF_8)
                    );
                    os.flush();
                } catch (Exception ignored) {
                }
            });
            serverThread.setDaemon(true);
            serverThread.start();

            SseStreamClient client = new SseStreamClient();
            try {
                String url = "http://127.0.0.1:" + server.getLocalPort() + "/v1/chat/completions";
                client.startStream(
                    "r1",
                    url,
                    "POST",
                    Map.of("Content-Type", "application/json"),
                    "{}",
                    new SseStreamClient.Listener() {
                        @Override
                        public void onChunk(String requestId, byte[] chunk, int length) {
                            chunks.add(new String(chunk, 0, length, StandardCharsets.UTF_8));
                            firstChunkReceived.countDown();
                        }

                        @Override
                        public void onComplete(String requestId) {
                            completed.countDown();
                        }

                        @Override
                        public void onError(String requestId, int status, String message, boolean aborted) {
                            completed.countDown();
                        }
                    }
                );

                assertTrue(
                    "Expected incremental first chunk before stream close",
                    firstChunkReceived.await(5, TimeUnit.SECONDS)
                );
                assertTrue("Expected stream completion", completed.await(5, TimeUnit.SECONDS));
                String joined = String.join("", chunks);
                assertTrue(joined.contains("第一块"));
                assertTrue(joined.contains("第二块"));
            } finally {
                client.shutdown();
            }
        }
    }

    @Test
    public void reportsNon2xxHttpErrorAndSupportsAbort() throws Exception {
        CountDownLatch slowStarted = new CountDownLatch(1);

        try (ServerSocket server = new ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))) {
            Thread serverThread = new Thread(() -> {
                for (int i = 0; i < 2; i++) {
                    try (Socket conn = server.accept()) {
                        String path = readRequestPath(conn);
                        OutputStream os = conn.getOutputStream();
                        if ("/err".equals(path)) {
                            byte[] body = "{\"error\":{\"message\":\"Unauthorized\"}}".getBytes(StandardCharsets.UTF_8);
                            os.write(
                                (
                                    "HTTP/1.1 401 Unauthorized\r\n"
                                        + "Content-Type: application/json\r\n"
                                        + "Content-Length: " + body.length + "\r\n"
                                        + "Connection: close\r\n\r\n"
                                ).getBytes(StandardCharsets.UTF_8)
                            );
                            os.write(body);
                            os.flush();
                        } else {
                            os.write(
                                (
                                    "HTTP/1.1 200 OK\r\n"
                                        + "Content-Type: text/event-stream\r\n"
                                        + "Connection: close\r\n\r\n"
                                ).getBytes(StandardCharsets.UTF_8)
                            );
                            os.write(
                                "data: {\"choices\":[{\"delta\":{\"content\":\"start\"}}]}\n\n"
                                    .getBytes(StandardCharsets.UTF_8)
                            );
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

            SseStreamClient client = new SseStreamClient();
            try {
                CountDownLatch errLatch = new CountDownLatch(1);
                AtomicInteger errStatus = new AtomicInteger();
                AtomicReference<String> errMsg = new AtomicReference<>("");
                String baseUrl = "http://127.0.0.1:" + server.getLocalPort();

                client.startStream(
                    "r-err",
                    baseUrl + "/err",
                    "POST",
                    Map.of(),
                    "{}",
                    new SseStreamClient.Listener() {
                        @Override
                        public void onChunk(String requestId, byte[] chunk, int length) {}

                        @Override
                        public void onComplete(String requestId) {}

                        @Override
                        public void onError(String requestId, int status, String message, boolean aborted) {
                            errStatus.set(status);
                            errMsg.set(message);
                            errLatch.countDown();
                        }
                    }
                );
                assertTrue(errLatch.await(5, TimeUnit.SECONDS));
                assertEquals(401, errStatus.get());
                assertTrue(errMsg.get().contains("Unauthorized"));

                CountDownLatch abortLatch = new CountDownLatch(1);
                AtomicReference<Boolean> wasAborted = new AtomicReference<>(false);
                client.startStream(
                    "r-abort",
                    baseUrl + "/slow",
                    "POST",
                    Map.of(),
                    "{}",
                    new SseStreamClient.Listener() {
                        @Override
                        public void onChunk(String requestId, byte[] chunk, int length) {}

                        @Override
                        public void onComplete(String requestId) {
                            abortLatch.countDown();
                        }

                        @Override
                        public void onError(String requestId, int status, String message, boolean aborted) {
                            wasAborted.set(aborted);
                            abortLatch.countDown();
                        }
                    }
                );
                assertTrue(slowStarted.await(5, TimeUnit.SECONDS));
                assertTrue(client.abortStream("r-abort"));
                assertTrue(abortLatch.await(5, TimeUnit.SECONDS));
                assertTrue(wasAborted.get());
                assertFalse(client.abortStream("r-abort"));
            } finally {
                client.shutdown();
            }
        }
    }
}
