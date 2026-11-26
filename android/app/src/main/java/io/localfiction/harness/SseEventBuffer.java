package io.localfiction.harness;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Pure JVM thread-safe per-requestId FIFO buffer for native SSE events emitted while the
 * Capacitor WebView/Activity is paused or resuming. Ensures chunks, completion, and error
 * events are neither dropped nor reordered across pause/resume transitions.
 */
final class SseEventBuffer {
    static final class SseEvent {
        enum Type {
            CHUNK,
            COMPLETE,
            ERROR,
        }

        final Type type;
        final String requestId;
        final String chunkBase64;
        final int status;
        final String code;
        final String message;
        final boolean aborted;

        private SseEvent(
            Type type,
            String requestId,
            String chunkBase64,
            int status,
            String code,
            String message,
            boolean aborted
        ) {
            this.type = type;
            this.requestId = requestId;
            this.chunkBase64 = chunkBase64;
            this.status = status;
            this.code = code;
            this.message = message;
            this.aborted = aborted;
        }

        static SseEvent chunk(String requestId, String chunkBase64) {
            return new SseEvent(Type.CHUNK, requestId, chunkBase64, 0, null, null, false);
        }

        static SseEvent complete(String requestId) {
            return new SseEvent(Type.COMPLETE, requestId, null, 0, null, null, false);
        }

        static SseEvent error(
            String requestId,
            int status,
            String code,
            String message,
            boolean aborted
        ) {
            return new SseEvent(Type.ERROR, requestId, null, status, code, message, aborted);
        }
    }

    @FunctionalInterface
    interface EventDispatcher {
        void dispatch(SseEvent event);
    }

    private final Object lock = new Object();
    private final Map<String, Deque<SseEvent>> queuesByRequest = new LinkedHashMap<>();
    private boolean paused = false;
    private boolean flushing = false;

    void onPause() {
        synchronized (lock) {
            paused = true;
        }
    }

    int onResume(EventDispatcher dispatcher) {
        if (dispatcher == null) {
            throw new IllegalArgumentException("dispatcher must not be null");
        }
        int dispatched = 0;
        while (true) {
            List<SseEvent> batch;
            synchronized (lock) {
                paused = false;
                if (queuesByRequest.isEmpty()) {
                    flushing = false;
                    return dispatched;
                }
                flushing = true;
                batch = drainAllQueuesLocked();
            }

            boolean completedBatch = false;
            try {
                for (SseEvent event : batch) {
                    dispatcher.dispatch(event);
                    dispatched++;
                }
                completedBatch = true;
            } finally {
                if (!completedBatch) {
                    synchronized (lock) {
                        flushing = false;
                    }
                }
            }

            synchronized (lock) {
                if (paused) {
                    flushing = false;
                    return dispatched;
                }
                if (queuesByRequest.isEmpty()) {
                    flushing = false;
                    return dispatched;
                }
            }
        }
    }

    void dispatchOrBuffer(SseEvent event, EventDispatcher dispatcher) {
        if (event == null || event.requestId == null || event.requestId.isEmpty()) {
            return;
        }
        synchronized (lock) {
            if (paused || flushing || queuesByRequest.containsKey(event.requestId)) {
                Deque<SseEvent> queue = queuesByRequest.computeIfAbsent(
                    event.requestId,
                    ignored -> new ArrayDeque<>()
                );
                queue.addLast(event);
                return;
            }
        }
        dispatcher.dispatch(event);
    }

    int clearRequest(String requestId) {
        if (requestId == null || requestId.isEmpty()) {
            return 0;
        }
        synchronized (lock) {
            Deque<SseEvent> removed = queuesByRequest.remove(requestId);
            return removed != null ? removed.size() : 0;
        }
    }

    void clearAll() {
        synchronized (lock) {
            queuesByRequest.clear();
            flushing = false;
        }
    }

    boolean isPaused() {
        synchronized (lock) {
            return paused;
        }
    }

    int getBufferedEventCount() {
        synchronized (lock) {
            int total = 0;
            for (Deque<SseEvent> queue : queuesByRequest.values()) {
                total += queue.size();
            }
            return total;
        }
    }

    int getTrackedRequestCount() {
        synchronized (lock) {
            return queuesByRequest.size();
        }
    }

    private List<SseEvent> drainAllQueuesLocked() {
        List<SseEvent> drained = new ArrayList<>();
        Iterator<Map.Entry<String, Deque<SseEvent>>> iterator = queuesByRequest.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<String, Deque<SseEvent>> entry = iterator.next();
            Deque<SseEvent> queue = entry.getValue();
            while (!queue.isEmpty()) {
                drained.add(queue.removeFirst());
            }
            // Remove empty per-request queue immediately so completed/errored streams release memory.
            iterator.remove();
        }
        return drained;
    }
}
