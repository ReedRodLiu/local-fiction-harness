package io.localfiction.harness;

import java.util.HashSet;
import java.util.Set;

/**
 * Pure JVM reference-counted coordinator for active SSE stream keepalive resources
 * (Android ForegroundService + bounded PARTIAL_WAKE_LOCK + FLAG_KEEP_SCREEN_ON).
 * Tracks distinct active requestIds so duplicate start/end calls cannot leak or underflow.
 */
final class SseKeepaliveCoordinator {
    static final long DEFAULT_WAKE_LOCK_TIMEOUT_MS = 10L * 60L * 1000L;

    interface Backend {
        void startKeepalive(long wakeLockTimeoutMs);

        default void refreshWakeLock(long wakeLockTimeoutMs) {}

        void stopKeepalive();
    }

    private final Backend backend;
    private final long wakeLockTimeoutMs;
    private final Set<String> activeRequestIds = new HashSet<>();

    SseKeepaliveCoordinator(Backend backend) {
        this(backend, DEFAULT_WAKE_LOCK_TIMEOUT_MS);
    }

    SseKeepaliveCoordinator(Backend backend, long wakeLockTimeoutMs) {
        if (backend == null) {
            throw new IllegalArgumentException("backend must not be null");
        }
        if (wakeLockTimeoutMs <= 0L) {
            throw new IllegalArgumentException("wakeLockTimeoutMs must be positive");
        }
        this.backend = backend;
        this.wakeLockTimeoutMs = wakeLockTimeoutMs;
    }

    synchronized boolean onStreamStart(String requestId) {
        if (requestId == null || requestId.isEmpty()) {
            return false;
        }
        if (!activeRequestIds.add(requestId)) {
            return false;
        }
        if (activeRequestIds.size() == 1) {
            backend.startKeepalive(wakeLockTimeoutMs);
        } else {
            backend.refreshWakeLock(wakeLockTimeoutMs);
        }
        return true;
    }

    synchronized boolean onStreamEnd(String requestId) {
        if (requestId == null || requestId.isEmpty()) {
            return false;
        }
        if (!activeRequestIds.remove(requestId)) {
            return false;
        }
        if (activeRequestIds.isEmpty()) {
            backend.stopKeepalive();
        }
        return true;
    }

    synchronized void releaseAll() {
        if (activeRequestIds.isEmpty()) {
            return;
        }
        activeRequestIds.clear();
        backend.stopKeepalive();
    }

    synchronized int getActiveCount() {
        return activeRequestIds.size();
    }

    synchronized boolean isActive(String requestId) {
        return requestId != null && activeRequestIds.contains(requestId);
    }
}
