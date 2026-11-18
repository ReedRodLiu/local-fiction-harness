package io.localfiction.harness;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Atomic file-backed StoryStorage operating inside an app-private directory.
 * Avoids WebView cache eviction and guards concurrent writes with a monitor lock + temp-file rename.
 */
public class PrivateStoryFileStore {
    private static final String STORIES_DIR_NAME = "stories";
    private static final String ACTIVE_FILE_NAME = "active_story.json";
    private static final String EXPORTS_DIR_NAME = "exports";

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
                String raw = readUtf8File(file);
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
            return new JSONObject(readUtf8File(target));
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
            ensureDirectory(storiesDir);
            writeUtf8Atomically(storyFileForId(id), story.toString());
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

    public static File writeExportBackupFile(File cacheDir, String requestedFileName, String jsonContent)
        throws IOException {
        File exportsDir = new File(cacheDir, EXPORTS_DIR_NAME);
        ensureDirectory(exportsDir);
        String safeName = sanitizeBackupFileName(requestedFileName);
        File outFile = new File(exportsDir, safeName);
        writeUtf8Atomically(outFile, jsonContent == null ? "" : jsonContent);
        return outFile;
    }

    private String getActiveStoryIdLocked() throws IOException, JSONException {
        if (!activeFile.isFile()) {
            return null;
        }
        JSONObject obj = new JSONObject(readUtf8File(activeFile));
        if (obj.isNull("activeStoryId")) {
            return null;
        }
        String id = obj.optString("activeStoryId", "");
        return id.isEmpty() ? null : id;
    }

    private void setActiveStoryIdLocked(String id) throws IOException, JSONException {
        ensureDirectory(activeFile.getParentFile());
        JSONObject payload = new JSONObject();
        payload.put("activeStoryId", id == null || id.isEmpty() ? JSONObject.NULL : id);
        writeUtf8Atomically(activeFile, payload.toString());
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

    private static String sanitizeBackupFileName(String requested) {
        String base = requested == null ? "" : requested.trim();
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) {
            base = base.substring(slash + 1);
        }
        base = base.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F]+", "_").replace("..", "_");
        if (base.isEmpty() || ".".equals(base)) {
            base = "story-backup.lfh.json";
        }
        if (!base.toLowerCase().endsWith(".json")) {
            base = base + ".json";
        }
        return base;
    }

    private static void ensureDirectory(File dir) throws IOException {
        if (dir != null && !dir.exists() && !dir.mkdirs() && !dir.isDirectory()) {
            throw new IOException("无法创建存储目录: " + dir.getAbsolutePath());
        }
    }

    private static String readUtf8File(File file) throws IOException {
        try (FileInputStream fis = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int read;
            while ((read = fis.read(buf)) != -1) {
                out.write(buf, 0, read);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static void writeUtf8Atomically(File target, String content) throws IOException {
        File parent = target.getParentFile();
        ensureDirectory(parent);
        File tmp = new File(parent, target.getName() + ".tmp." + UUID.randomUUID());
        boolean renamed = false;
        try {
            try (FileOutputStream fos = new FileOutputStream(tmp)) {
                fos.write(content.getBytes(StandardCharsets.UTF_8));
                fos.flush();
                fos.getFD().sync();
            }
            if (tmp.renameTo(target)) {
                renamed = true;
            } else {
                if (target.exists() && !target.delete()) {
                    throw new IOException("无法替换目标文件: " + target.getName());
                }
                if (!tmp.renameTo(target)) {
                    throw new IOException("原子重命名失败: " + target.getName());
                }
                renamed = true;
            }
        } finally {
            if (!renamed && tmp.exists()) {
                // Best effort cleanup of orphaned temp file
                tmp.delete();
            }
        }
    }
}
