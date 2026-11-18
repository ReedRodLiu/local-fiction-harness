package io.localfiction.harness;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Atomic file-backed StoryStorage operating inside an app-private directory.
 * Avoids WebView cache eviction and guards concurrent writes with a monitor lock + temp-file rename.
 */
public class PrivateStoryFileStore {
    private static final String STORIES_DIR_NAME = "stories";
    private static final String ACTIVE_FILE_NAME = "active_story.json";

    private final Object lock = new Object();
    private final File storiesDir;
    private final File activeFile;

    public PrivateStoryFileStore(File rootDir) {
        this.storiesDir = new File(rootDir, STORIES_DIR_NAME);
        this.activeFile = new File(rootDir, ACTIVE_FILE_NAME);
    }

    public List<JSONObject> listStories() throws IOException, JSONException {
        synchronized (lock) {
            if (!storiesDir.exists()) {
                return Collections.emptyList();
            }
            File[] files = storiesDir.listFiles();
            if (files == null) {
                return Collections.emptyList();
            }
            List<JSONObject> results = new ArrayList<>();
            for (File file : files) {
                if (!file.isFile() || !file.getName().endsWith(".json")) {
                    continue;
                }
                String raw = AtomicFileHelper.readUtf8File(file);
                results.add(new JSONObject(raw));
            }
            results.sort(Comparator.comparingLong((JSONObject s) -> s.optLong("updatedAt", 0L)).reversed());
            return results;
        }
    }

    public JSONObject getStory(String id) throws IOException, JSONException {
        if (id == null || id.isEmpty()) {
            return null;
        }
        synchronized (lock) {
            File target = storyFileForId(id);
            if (!target.isFile()) {
                return null;
            }
            return new JSONObject(AtomicFileHelper.readUtf8File(target));
        }
    }

    public void saveStory(JSONObject story) throws IOException, JSONException {
        if (story == null || !story.has("id")) {
            throw new IllegalArgumentException("story.id is required.");
        }
        String id = story.getString("id");
        if (id.isEmpty()) {
            throw new IllegalArgumentException("story.id cannot be empty.");
        }
        synchronized (lock) {
            AtomicFileHelper.ensureDirectory(storiesDir);
            AtomicFileHelper.writeUtf8Atomically(storyFileForId(id), story.toString());
        }
    }

    public void deleteStory(String id) throws IOException, JSONException {
        if (id == null || id.isEmpty()) {
            return;
        }
        synchronized (lock) {
            File target = storyFileForId(id);
            if (target.exists() && !target.delete()) {
                throw new IOException("无法删除故事文件: " + target.getName());
            }
            String activeId = getActiveStoryIdLocked();
            if (id.equals(activeId)) {
                setActiveStoryIdLocked(null);
            }
        }
    }

    public String getActiveStoryId() throws IOException, JSONException {
        synchronized (lock) {
            return getActiveStoryIdLocked();
        }
    }

    public void setActiveStoryId(String id) throws IOException, JSONException {
        synchronized (lock) {
            setActiveStoryIdLocked(id);
        }
    }

    private String getActiveStoryIdLocked() throws IOException, JSONException {
        if (!activeFile.isFile()) {
            return null;
        }
        JSONObject obj = new JSONObject(AtomicFileHelper.readUtf8File(activeFile));
        if (obj.isNull("activeStoryId")) {
            return null;
        }
        String id = obj.optString("activeStoryId", "");
        return id.isEmpty() ? null : id;
    }

    private void setActiveStoryIdLocked(String id) throws IOException, JSONException {
        AtomicFileHelper.ensureDirectory(activeFile.getParentFile());
        JSONObject payload = new JSONObject();
        payload.put("activeStoryId", id == null || id.isEmpty() ? JSONObject.NULL : id);
        AtomicFileHelper.writeUtf8Atomically(activeFile, payload.toString());
    }

    private File storyFileForId(String id) {
        return new File(storiesDir, encodeHexUtf8(id) + ".json");
    }

    private static String encodeHexUtf8(String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }
}
