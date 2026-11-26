package io.localfiction.harness;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class SseKeepaliveCoordinatorTest {
    private static final class RecordingBackend implements SseKeepaliveCoordinator.Backend {
        final List<String> events = new ArrayList<>();
        int startCount = 0;
        int refreshCount = 0;
        int stopCount = 0;

        @Override
        public void startKeepalive(long wakeLockTimeoutMs) {
            startCount++;
            events.add("start:" + wakeLockTimeoutMs);
        }

        @Override
        public void refreshWakeLock(long wakeLockTimeoutMs) {
            refreshCount++;
            events.add("refresh:" + wakeLockTimeoutMs);
        }

        @Override
        public void stopKeepalive() {
            stopCount++;
            events.add("stop");
        }
    }

    @Test
    public void acquiresOnFirstStreamAndReleasesOnlyWhenLastStreamEnds() {
        RecordingBackend backend = new RecordingBackend();
        SseKeepaliveCoordinator coordinator = new SseKeepaliveCoordinator(backend, 600_000L);

        assertEquals(0, coordinator.getActiveCount());
        assertTrue(coordinator.onStreamStart("req-1"));
        assertEquals(1, coordinator.getActiveCount());
        assertTrue(coordinator.isActive("req-1"));
        assertEquals(1, backend.startCount);
        assertEquals(0, backend.stopCount);

        assertTrue(coordinator.onStreamStart("req-2"));
        assertEquals(2, coordinator.getActiveCount());
        assertEquals(1, backend.startCount);
        assertEquals(1, backend.refreshCount);
        assertEquals(0, backend.stopCount);

        assertTrue(coordinator.onStreamEnd("req-1"));
        assertEquals(1, coordinator.getActiveCount());
        assertFalse(coordinator.isActive("req-1"));
        assertTrue(coordinator.isActive("req-2"));
        assertEquals(0, backend.stopCount);

        assertTrue(coordinator.onStreamEnd("req-2"));
        assertEquals(0, coordinator.getActiveCount());
        assertEquals(1, backend.stopCount);
        assertEquals(List.of("start:600000", "refresh:600000", "stop"), backend.events);
    }

    @Test
    public void handlesDuplicateStartAndRepeatedEndWithoutUnderflow() {
        RecordingBackend backend = new RecordingBackend();
        SseKeepaliveCoordinator coordinator = new SseKeepaliveCoordinator(backend, 300_000L);

        assertFalse(coordinator.onStreamStart(""));
        assertFalse(coordinator.onStreamStart(null));
        assertTrue(coordinator.onStreamStart("req-1"));
        assertFalse(coordinator.onStreamStart("req-1"));
        assertEquals(1, coordinator.getActiveCount());
        assertEquals(1, backend.startCount);
        assertEquals(0, backend.refreshCount);

        assertTrue(coordinator.onStreamEnd("req-1"));
        assertFalse(coordinator.onStreamEnd("req-1"));
        assertFalse(coordinator.onStreamEnd("unknown"));
        assertEquals(0, coordinator.getActiveCount());
        assertEquals(1, backend.stopCount);

        // Starting a fresh cycle after returning to zero re-acquires cleanly.
        assertTrue(coordinator.onStreamStart("req-3"));
        assertEquals(2, backend.startCount);
        assertTrue(coordinator.onStreamEnd("req-3"));
        assertEquals(2, backend.stopCount);
    }

    @Test
    public void releaseAllClearsAllActiveStreamsAndStopsKeepaliveOnce() {
        RecordingBackend backend = new RecordingBackend();
        SseKeepaliveCoordinator coordinator = new SseKeepaliveCoordinator(backend, 300_000L);

        coordinator.releaseAll();
        assertEquals(0, backend.stopCount);

        coordinator.onStreamStart("req-1");
        coordinator.onStreamStart("req-2");
        assertEquals(2, coordinator.getActiveCount());

        coordinator.releaseAll();
        assertEquals(0, coordinator.getActiveCount());
        assertEquals(1, backend.stopCount);

        // Subsequent late stream end after releaseAll is a safe no-op.
        assertFalse(coordinator.onStreamEnd("req-1"));
        assertEquals(1, backend.stopCount);
    }
}
