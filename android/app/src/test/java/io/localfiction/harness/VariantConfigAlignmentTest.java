package io.localfiction.harness;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.pm.ApplicationInfo;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

public class VariantConfigAlignmentTest {
    @Test
    public void debugBuildConfigEnablesWebViewDebuggingAndDisablesLoopbackHttp() {
        assertEquals("io.localfiction.harness", BuildConfig.APPLICATION_ID);
        assertEquals("debug", BuildConfig.BUILD_TYPE);
        assertTrue(BuildConfig.ALLOW_WEBVIEW_DEBUGGING);
        assertFalse(BuildConfig.ALLOW_LOOPBACK_HTTP);
    }

    @Test
    public void mainActivityDoubleLockRequiresBothBuildConfigAndFlagDebuggable() {
        int debuggableFlags = ApplicationInfo.FLAG_DEBUGGABLE;
        int releaseFlags = 0;

        assertTrue(MainActivity.shouldEnableWebViewDebugging(true, debuggableFlags));
        assertFalse(MainActivity.shouldEnableWebViewDebugging(false, debuggableFlags));
        assertFalse(MainActivity.shouldEnableWebViewDebugging(true, releaseFlags));
        assertFalse(MainActivity.shouldEnableWebViewDebugging(false, releaseFlags));
    }

    @Test
    public void sseForegroundServiceDerivesActionFromPackageNameAndKeepsDefault() {
        assertEquals(
            "io.localfiction.harness.action.START_SSE_KEEPALIVE",
            SseForegroundService.ACTION_START
        );
        assertEquals(
            "io.localfiction.harness.action.START_SSE_KEEPALIVE",
            SseForegroundService.buildStartAction("io.localfiction.harness")
        );
        assertEquals(
            "io.localfiction.harness.e2e.action.START_SSE_KEEPALIVE",
            SseForegroundService.buildStartAction("io.localfiction.harness.e2e")
        );
        assertEquals(
            "io.localfiction.harness.smoke.action.START_SSE_KEEPALIVE",
            SseForegroundService.buildStartAction("io.localfiction.harness.smoke")
        );
        assertEquals(
            SseForegroundService.ACTION_START,
            SseForegroundService.buildStartAction((String) null)
        );
        assertEquals(
            SseForegroundService.ACTION_START,
            SseForegroundService.buildStartAction("   ")
        );
    }

    @Test
    public void nativeClientsAlignedWithDebugBuildConfigRejectLoopbackHttp() throws Exception {
        ApkUpdateClient updater = new ApkUpdateClient(BuildConfig.ALLOW_LOOPBACK_HTTP);
        BinaryDownloadClient downloader = new BinaryDownloadClient(BuildConfig.ALLOW_LOOPBACK_HTTP);
        try {
            try {
                updater.fetchJson("http://127.0.0.1:8080/releases.json", 4096);
                fail("Expected ApkUpdateClient with ALLOW_LOOPBACK_HTTP=false to reject http://127.0.0.1");
            } catch (IllegalArgumentException expected) {
                assertTrue(expected.getMessage().contains("HTTPS"));
            }

            CountDownLatch latch = new CountDownLatch(1);
            AtomicReference<String> errorMsg = new AtomicReference<>("");
            downloader.startDownload(
                "req-loopback",
                "http://127.0.0.1:8080/export.zip",
                1024,
                new BinaryDownloadClient.Listener() {
                    @Override
                    public void onChunk(String requestId, byte[] chunk, int length) {}

                    @Override
                    public void onComplete(String requestId, String contentType) {
                        latch.countDown();
                    }

                    @Override
                    public void onError(String requestId, int status, String message, boolean aborted) {
                        errorMsg.set(message);
                        latch.countDown();
                    }
                }
            );
            assertTrue(latch.await(5, TimeUnit.SECONDS));
            assertTrue(errorMsg.get().contains("HTTPS"));
        } finally {
            updater.shutdown();
            downloader.shutdown();
        }
    }
}
