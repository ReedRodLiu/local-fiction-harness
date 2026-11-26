package io.localfiction.harness;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;

public class SseEventBufferTest {
    @Test
    public void dispatchesImmediatelyWhenNotPaused() {
        SseEventBuffer buffer = new SseEventBuffer();
        List<SseEventBuffer.SseEvent> dispatched = new ArrayList<>();

        assertFalse(buffer.isPaused());
        buffer.dispatchOrBuffer(SseEventBuffer.SseEvent.chunk("req-1", "Y2h1bmsx"), dispatched::add);
        buffer.dispatchOrBuffer(SseEventBuffer.SseEvent.complete("req-1"), dispatched::add);

        assertEquals(2, dispatched.size());
        assertEquals(SseEventBuffer.SseEvent.Type.CHUNK, dispatched.get(0).type);
        assertEquals("Y2h1bmsx", dispatched.get(0).chunkBase64);
        assertEquals(SseEventBuffer.SseEvent.Type.COMPLETE, dispatched.get(1).type);
        assertEquals(0, buffer.getBufferedEventCount());
        assertEquals(0, buffer.getTrackedRequestCount());
    }

    @Test
    public void buffersWhilePausedAndFlushesInExactFifoOrderOnResume() {
        SseEventBuffer buffer = new SseEventBuffer();
        List<SseEventBuffer.SseEvent> dispatched = new ArrayList<>();

        buffer.onPause();
        assertTrue(buffer.isPaused());

        buffer.dispatchOrBuffer(SseEventBuffer.SseEvent.chunk("req-1", "YzE="), dispatched::add);
        buffer.dispatchOrBuffer(SseEventBuffer.SseEvent.chunk("req-1", "YzI="), dispatched::add);
        buffer.dispatchOrBuffer(SseEventBuffer.SseEvent.chunk("req-1", "YzM="), dispatched::add);
        buffer.dispatchOrBuffer(SseEventBuffer.SseEvent.complete("req-1"), dispatched::add);

        assertEquals(0, dispatched.size());
        assertEquals(4, buffer.getBufferedEventCount());
        assertEquals(1, buffer.getTrackedRequestCount());

        int flushed = buffer.onResume(dispatched::add);
        assertEquals(4, flushed);
        assertFalse(buffer.isPaused());
        assertEquals(4, dispatched.size());
        assertEquals("YzE=", dispatched.get(0).chunkBase64);
        assertEquals("YzI=", dispatched.get(1).chunkBase64);
        assertEquals("YzM=", dispatched.get(2).chunkBase64);
        assertEquals(SseEventBuffer.SseEvent.Type.COMPLETE, dispatched.get(3).type);

        // Request queue must be cleaned up after flush to prevent memory bloat.
        assertEquals(0, buffer.getBufferedEventCount());
        assertEquals(0, buffer.getTrackedRequestCount());

        // Subsequent onResume without new events does not duplicate anything.
        assertEquals(0, buffer.onResume(dispatched::add));
        assertEquals(4, dispatched.size());
    }

    @Test
    public void isolatesRequestsAndPreservesBufferedErrorAfterPartialChunks() {
        SseEventBuffer buffer = new SseEventBuffer();
        List<SseEventBuffer.SseEvent> dispatched = new ArrayList<>();

        buffer.onPause();
        buffer.dispatchOrBuffer(SseEventBuffer.SseEvent.chunk("req-a", "YTE="), dispatched::add);
        buffer.dispatchOrBuffer(SseEventBuffer.SseEvent.chunk("req-b", "YjE="), dispatched::add);
        buffer.dispatchOrBuffer(
            SseEventBuffer.SseEvent.error("req-a", 0, "CONNECTION_ABORTED", "连接中断", false),
            dispatched::add
        );
        buffer.dispatchOrBuffer(SseEventBuffer.SseEvent.chunk("req-b", "YjI="), dispatched::add);
        buffer.dispatchOrBuffer(SseEventBuffer.SseEvent.complete("req-b"), dispatched::add);

        assertEquals(2, buffer.getTrackedRequestCount());
        assertEquals(5, buffer.getBufferedEventCount());

        int flushed = buffer.onResume(dispatched::add);
        assertEquals(5, flushed);
        assertEquals(0, buffer.getTrackedRequestCount());

        List<String> reqAEvents = new ArrayList<>();
        List<String> reqBEvents = new ArrayList<>();
        for (SseEventBuffer.SseEvent ev : dispatched) {
            if ("req-a".equals(ev.requestId)) {
                reqAEvents.add(ev.type + ":" + (ev.chunkBase64 != null ? ev.chunkBase64 : ev.code));
            } else if ("req-b".equals(ev.requestId)) {
                reqBEvents.add(ev.type + ":" + (ev.chunkBase64 != null ? ev.chunkBase64 : "DONE"));
            }
        }
        assertEquals(List.of("CHUNK:YTE=", "ERROR:CONNECTION_ABORTED"), reqAEvents);
        assertEquals(List.of("CHUNK:YjE=", "CHUNK:YjI=", "COMPLETE:DONE"), reqBEvents);
    }

    @Test
    public void clearRequestRemovesAbortedRequestBufferWithoutAffectingOthers() {
        SseEventBuffer buffer = new SseEventBuffer();
        List<SseEventBuffer.SseEvent> dispatched = new ArrayList<>();

        buffer.onPause();
        buffer.dispatchOrBuffer(SseEventBuffer.SseEvent.chunk("req-abort", "YTE="), dispatched::add);
        buffer.dispatchOrBuffer(
            SseEventBuffer.SseEvent.error("req-abort", 0, "ABORTED", "操作已中止。", true),
            dispatched::add
        );
        buffer.dispatchOrBuffer(SseEventBuffer.SseEvent.chunk("req-keep", "azE="), dispatched::add);

        int cleared = buffer.clearRequest("req-abort");
        assertEquals(2, cleared);
        assertEquals(0, buffer.clearRequest("req-abort"));
        assertEquals(1, buffer.getTrackedRequestCount());
        assertEquals(1, buffer.getBufferedEventCount());

        buffer.onResume(dispatched::add);
        assertEquals(1, dispatched.size());
        assertEquals("req-keep", dispatched.get(0).requestId);
        assertEquals("azE=", dispatched.get(0).chunkBase64);
    }

    @Test
    public void preservesStrictOrderWhenNewEventsArriveDuringResumeFlush() throws Exception {
        SseEventBuffer buffer = new SseEventBuffer();
        List<String> delivered = new ArrayList<>();
        CountDownLatch firstDispatched = new CountDownLatch(1);
        CountDownLatch concurrentEnqueued = new CountDownLatch(1);
        AtomicBoolean injected = new AtomicBoolean(false);

        buffer.onPause();
        buffer.dispatchOrBuffer(SseEventBuffer.SseEvent.chunk("req-1", "1"), ev -> {});
        buffer.dispatchOrBuffer(SseEventBuffer.SseEvent.chunk("req-1", "2"), ev -> {});

        Thread producer = new Thread(() -> {
            try {
                if (firstDispatched.await(5, TimeUnit.SECONDS)) {
                    buffer.dispatchOrBuffer(
                        SseEventBuffer.SseEvent.chunk("req-1", "3"),
                        ev -> delivered.add("direct:" + ev.chunkBase64)
                    );
                    buffer.dispatchOrBuffer(
                        SseEventBuffer.SseEvent.complete("req-1"),
                        ev -> delivered.add("direct:complete")
                    );
                    concurrentEnqueued.countDown();
                }
            } catch (InterruptedException ignored) {
            }
        });
        producer.start();

        buffer.onResume(ev -> {
            delivered.add(ev.type == SseEventBuffer.SseEvent.Type.COMPLETE ? "complete" : ev.chunkBase64);
            if (injected.compareAndSet(false, true)) {
                firstDispatched.countDown();
                try {
                    concurrentEnqueued.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException ignored) {
                }
            }
        });
        producer.join(5000);

        assertEquals(List.of("1", "2", "3", "complete"), delivered);
        assertEquals(0, buffer.getBufferedEventCount());
    }
}
