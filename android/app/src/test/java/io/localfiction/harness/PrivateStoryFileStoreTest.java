package io.localfiction.harness;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class PrivateStoryFileStoreTest {
    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private JSONObject makeStory(String id, String title, long updatedAt) throws Exception {
        return new JSONObject()
            .put("id", id)
            .put("title", title)
            .put("rawScript", "剧本原文")
            .put("updatedAt", updatedAt)
            .put("createdAt", 1000L);
    }

    @Test
    public void persistsListsDeletesAndTracksActiveStoryAtomically() throws Exception {
        File root = tempFolder.newFolder("lfh_stories");
        PrivateStoryFileStore store = new PrivateStoryFileStore(root);

        assertNull(store.getActiveStoryId());
        assertEquals(0, store.listStories().size());

        store.saveStory(makeStory("story/a:1", "故事A", 100L));
        store.saveStory(makeStory("story-b", "故事B", 200L));
        store.setActiveStoryId("story/a:1");

        assertEquals("story/a:1", store.getActiveStoryId());
        List<JSONObject> listed = store.listStories();
        assertEquals(2, listed.size());
        assertEquals("story-b", listed.get(0).getString("id"));
        assertEquals("story/a:1", listed.get(1).getString("id"));
        assertEquals("故事A", store.getStory("story/a:1").getString("title"));

        // Verify no leftover .tmp files in stories directory
        File storiesDir = new File(root, "stories");
        for (File f : storiesDir.listFiles()) {
            assertTrue(f.getName().endsWith(".json"));
        }

        // Deleting active story clears activeStoryId
        store.deleteStory("story/a:1");
        assertNull(store.getStory("story/a:1"));
        assertNull(store.getActiveStoryId());
        assertEquals(1, store.listStories().size());
    }

    @Test
    public void survivesConcurrentWritesWithoutCorruptingJson() throws Exception {
        File root = tempFolder.newFolder("lfh_concurrent");
        PrivateStoryFileStore store = new PrivateStoryFileStore(root);
        int writers = 8;
        int iterations = 15;
        ExecutorService pool = Executors.newFixedThreadPool(writers);
        CountDownLatch done = new CountDownLatch(writers);

        for (int w = 0; w < writers; w++) {
            final int workerId = w;
            pool.submit(() -> {
                try {
                    for (int i = 0; i < iterations; i++) {
                        store.saveStory(makeStory("shared-story", "W" + workerId + "-" + i, workerId * 100L + i));
                    }
                } catch (Exception e) {
                    throw new RuntimeException(e);
                } finally {
                    done.countDown();
                }
            });
        }

        assertTrue(done.await(10, TimeUnit.SECONDS));
        pool.shutdownNow();

        JSONObject finalStory = store.getStory("shared-story");
        assertEquals("shared-story", finalStory.getString("id"));
        assertTrue(finalStory.getString("title").startsWith("W"));
    }

    @Test
    public void writesSanitizedBackupFileInExportsDir() throws Exception {
        File cacheDir = tempFolder.newFolder("cache");
        File out = PrivateStoryFileStore.writeExportBackupFile(cacheDir, "../evil/故事:备份.lfh.json", "{\"schemaVersion\":1}");
        assertTrue(out.exists());
        assertEquals("exports", out.getParentFile().getName());
        assertTrue(out.getName().endsWith(".json"));
        assertTrue(!out.getName().contains(".."));
        assertEquals("{\"schemaVersion\":1}", new String(Files.readAllBytes(out.toPath()), StandardCharsets.UTF_8));
    }
}
