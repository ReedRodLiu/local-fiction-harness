package io.localfiction.harness;

import java.util.function.Consumer;
import org.json.JSONObject;

final class ExitFlushCoordinator {
    static final long DEFAULT_FLUSH_TIMEOUT_MS = 300L;
    static final long DEFAULT_POLL_INTERVAL_MS = 25L;

    interface Scheduler {
        void postDelayed(Runnable action, long delayMs);
        void removeCallbacks(Runnable action);
    }

    interface EvalRunner {
        void evaluate(String script, Consumer<String> callback);
    }

    private final Scheduler scheduler;
    private final EvalRunner evalRunner;
    private final Runnable finishAction;
    private final long timeoutMs;
    private final long pollIntervalMs;

    private boolean completed = false;
    private String activeToken = null;

    private final Runnable timeoutRunnable = this::complete;
    private final Runnable pollRunnable = this::pollFlushState;

    ExitFlushCoordinator(Scheduler scheduler, EvalRunner evalRunner, Runnable finishAction) {
        this(scheduler, evalRunner, finishAction, DEFAULT_FLUSH_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS);
    }

    ExitFlushCoordinator(
        Scheduler scheduler,
        EvalRunner evalRunner,
        Runnable finishAction,
        long timeoutMs,
        long pollIntervalMs
    ) {
        this.scheduler = scheduler;
        this.evalRunner = evalRunner;
        this.finishAction = finishAction;
        this.timeoutMs = timeoutMs;
        this.pollIntervalMs = pollIntervalMs;
    }

    void flushAndFinish(String token) {
        completed = false;
        activeToken = token;
        scheduler.postDelayed(timeoutRunnable, timeoutMs);
        evalRunner.evaluate(buildFlushBeforeExitScript(token), rawResult -> {
            if (completed || !token.equals(activeToken)) return;
            if (!"pending".equals(unquote(rawResult))) {
                complete();
                return;
            }
            scheduler.postDelayed(pollRunnable, pollIntervalMs);
        });
    }

    void cancel() {
        completed = true;
        scheduler.removeCallbacks(timeoutRunnable);
        scheduler.removeCallbacks(pollRunnable);
    }

    private void pollFlushState() {
        if (completed || activeToken == null) return;
        final String token = activeToken;
        evalRunner.evaluate(buildCheckFlushDoneScript(token), rawResult -> {
            if (completed || !token.equals(activeToken)) return;
            if ("true".equals(unquote(rawResult))) {
                complete();
                return;
            }
            scheduler.postDelayed(pollRunnable, pollIntervalMs);
        });
    }

    private void complete() {
        if (completed) return;
        completed = true;
        scheduler.removeCallbacks(timeoutRunnable);
        scheduler.removeCallbacks(pollRunnable);
        finishAction.run();
    }

    static String buildFlushBeforeExitScript(String token) {
        return "(function(token){" +
            "try{" +
            "var fn=window.__lfhFlushManuscript;" +
            "if(typeof fn!=='function')return 'none';" +
            "var hasPending=typeof window.__lfhHasPendingManuscriptFlush==='function'" +
            "?Boolean(window.__lfhHasPendingManuscriptFlush()):true;" +
            "var res=fn();" +
            "if(!hasPending)return 'done';" +
            "if(res&&typeof res.then==='function'){" +
            "window.__lfhExitFlushState={token:token,done:false};" +
            "res.then(" +
            "function(){if(window.__lfhExitFlushState&&window.__lfhExitFlushState.token===token)" +
            "window.__lfhExitFlushState.done=true;}," +
            "function(){if(window.__lfhExitFlushState&&window.__lfhExitFlushState.token===token)" +
            "window.__lfhExitFlushState.done=true;}" +
            ");" +
            "return 'pending';" +
            "}" +
            "return 'done';" +
            "}catch(e){return 'error';}" +
            "})(" + JSONObject.quote(token) + ")";
    }

    static String buildCheckFlushDoneScript(String token) {
        return "(function(token){" +
            "try{" +
            "return Boolean(window.__lfhExitFlushState&&" +
            "window.__lfhExitFlushState.token===token&&" +
            "window.__lfhExitFlushState.done===true);" +
            "}catch(e){return true;}" +
            "})(" + JSONObject.quote(token) + ")";
    }

    private static String unquote(String raw) {
        if (raw == null) return "";
        return raw.replace("\"", "").trim();
    }
}
