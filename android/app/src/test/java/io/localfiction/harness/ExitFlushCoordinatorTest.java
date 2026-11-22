package io.localfiction.harness;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.junit.Test;

public class ExitFlushCoordinatorTest {
    private static final class FakeScheduler implements ExitFlushCoordinator.Scheduler {
        private static final class ScheduledTask {
            final long runAtMs;
            final Runnable action;

            ScheduledTask(long runAtMs, Runnable action) {
                this.runAtMs = runAtMs;
                this.action = action;
            }
        }

        long nowMs = 0L;
        final List<ScheduledTask> tasks = new ArrayList<>();

        @Override
        public void postDelayed(Runnable action, long delayMs) {
            tasks.add(new ScheduledTask(nowMs + delayMs, action));
        }

        @Override
        public void removeCallbacks(Runnable action) {
            Iterator<ScheduledTask> it = tasks.iterator();
            while (it.hasNext()) {
                if (it.next().action == action) {
                    it.remove();
                }
            }
        }

        void advanceBy(long deltaMs) {
            long target = nowMs + deltaMs;
            while (true) {
                ScheduledTask next = tasks.stream()
                    .filter(t -> t.runAtMs <= target)
                    .min(Comparator.comparingLong(t -> t.runAtMs))
                    .orElse(null);
                if (next == null) break;
                tasks.remove(next);
                nowMs = next.runAtMs;
                next.action.run();
            }
            nowMs = target;
        }
    }

    @Test
    public void finishesImmediatelyAndCancelsTimeoutWhenNothingPending() {
        for (String jsResult : new String[] {"\"none\"", "\"done\"", "\"error\"", "null", null}) {
            FakeScheduler scheduler = new FakeScheduler();
            List<String> scripts = new ArrayList<>();
            int[] finishCount = {0};

            ExitFlushCoordinator coordinator = new ExitFlushCoordinator(
                scheduler,
                (script, callback) -> {
                    scripts.add(script);
                    callback.accept(jsResult);
                },
                () -> finishCount[0] += 1
            );

            coordinator.flushAndFinish("token-1");

            assertEquals(1, scripts.size());
            assertTrue(scripts.get(0).contains("__lfhFlushManuscript"));
            assertEquals(1, finishCount[0]);
            assertTrue(scheduler.tasks.isEmpty());
        }
    }

    @Test
    public void waitsForPendingFlushToCompleteBeforeTimeout() {
        FakeScheduler scheduler = new FakeScheduler();
        List<String> scripts = new ArrayList<>();
        int[] pollCount = {0};
        int[] finishCount = {0};

        ExitFlushCoordinator coordinator = new ExitFlushCoordinator(
            scheduler,
            (script, callback) -> {
                scripts.add(script);
                if (scripts.size() == 1) {
                    callback.accept("\"pending\"");
                    return;
                }
                pollCount[0] += 1;
                callback.accept(pollCount[0] >= 2 ? "true" : "false");
            },
            () -> finishCount[0] += 1
        );

        coordinator.flushAndFinish("token-2");
        assertEquals(0, finishCount[0]);

        // Poll 1 at 25ms -> still pending
        scheduler.advanceBy(25L);
        assertEquals(1, pollCount[0]);
        assertEquals(0, finishCount[0]);

        // Poll 2 at 50ms -> complete! Finishes once and clears remaining 300ms timeout
        scheduler.advanceBy(25L);
        assertEquals(2, pollCount[0]);
        assertEquals(1, finishCount[0]);
        assertTrue(scheduler.tasks.isEmpty());

        // Advancing past 300ms must not fire finish a second time
        scheduler.advanceBy(300L);
        assertEquals(1, finishCount[0]);
    }

    @Test
    public void capsStalledPendingFlushAt300msTimeout() {
        FakeScheduler scheduler = new FakeScheduler();
        int[] finishCount = {0};

        ExitFlushCoordinator coordinator = new ExitFlushCoordinator(
            scheduler,
            (script, callback) -> {
                if (script.contains("__lfhFlushManuscript")) {
                    callback.accept("\"pending\"");
                } else {
                    callback.accept("false");
                }
            },
            () -> finishCount[0] += 1
        );

        coordinator.flushAndFinish("token-3");
        scheduler.advanceBy(299L);
        assertEquals(0, finishCount[0]);

        scheduler.advanceBy(1L);
        assertEquals(1, finishCount[0]);
        assertTrue(scheduler.tasks.isEmpty());
    }

    @Test
    public void cancelPreventsLateFinish() {
        FakeScheduler scheduler = new FakeScheduler();
        int[] finishCount = {0};
        AtomicReference<Consumer<String>> captured = new AtomicReference<>();

        ExitFlushCoordinator coordinator = new ExitFlushCoordinator(
            scheduler,
            (script, callback) -> captured.set(callback),
            () -> finishCount[0] += 1
        );

        coordinator.flushAndFinish("token-4");
        coordinator.cancel();
        assertFalse(scheduler.tasks.stream().anyMatch(t -> t != null));

        captured.get().accept("\"done\"");
        scheduler.advanceBy(500L);
        assertEquals(0, finishCount[0]);
    }
}
