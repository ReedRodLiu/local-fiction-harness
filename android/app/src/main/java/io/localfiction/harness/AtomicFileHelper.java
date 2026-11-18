package io.localfiction.harness;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * Shared atomic UTF-8 file helpers and backup export file staging in app cache dir.
 */
final class AtomicFileHelper {
    private static final String EXPORTS_DIR_NAME = "exports";
    static final String DEFAULT_BACKUP_FILENAME = "story-backup.lfh.json";

    private AtomicFileHelper() {}

    static void ensureDirectory(File dir) throws IOException {
        if (dir != null && !dir.exists() && !dir.mkdirs() && !dir.isDirectory()) {
            throw new IOException("无法创建存储目录: " + dir.getAbsolutePath());
        }
    }

    static String readUtf8File(File file) throws IOException {
        try (FileInputStream fis = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int read;
            while ((read = fis.read(buf)) != -1) {
                out.write(buf, 0, read);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    static void writeUtf8Atomically(File target, String content) throws IOException {
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
                tmp.delete();
            }
        }
    }

    static File writeExportBackupFile(File cacheDir, String requestedFileName, String jsonContent)
        throws IOException {
        File exportsDir = new File(cacheDir, EXPORTS_DIR_NAME);
        ensureDirectory(exportsDir);
        String safeName = sanitizeBackupFileName(requestedFileName);
        File outFile = new File(exportsDir, safeName);
        writeUtf8Atomically(outFile, jsonContent == null ? "" : jsonContent);
        return outFile;
    }

    static String sanitizeBackupFileName(String requested) {
        String base = requested == null ? "" : requested.trim();
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) {
            base = base.substring(slash + 1);
        }
        base = base.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F]+", "_").replace("..", "_");
        if (base.isEmpty() || ".".equals(base)) {
            base = DEFAULT_BACKUP_FILENAME;
        }
        if (!base.toLowerCase().endsWith(".json")) {
            base = base + ".lfh.json";
        }
        return base;
    }
}
