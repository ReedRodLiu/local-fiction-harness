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
        writeBytesAtomically(target, content.getBytes(StandardCharsets.UTF_8));
    }

    private static void writeBytesAtomically(File target, byte[] content) throws IOException {
        File parent = target.getParentFile();
        ensureDirectory(parent);
        File tmp = new File(parent, target.getName() + ".tmp." + UUID.randomUUID());
        boolean renamed = false;
        try {
            try (FileOutputStream fos = new FileOutputStream(tmp)) {
                fos.write(content);
                fos.flush();
                fos.getFD().sync();
            }
            if (!tmp.renameTo(target)) {
                throw new IOException("原子重命名失败: " + target.getName());
            }
            renamed = true;
        } finally {
            if (!renamed && tmp.exists()) {
                tmp.delete();
            }
        }
    }

    static File writeExportBackupFile(File cacheDir, String requestedFileName, String jsonContent)
        throws IOException {
        return writeExportFile(cacheDir, requestedFileName, jsonContent, false);
    }

    static File writeExportFile(File cacheDir, String requestedFileName, String content, boolean markdown)
        throws IOException {
        String safeName = sanitizeBackupFileName(requestedFileName);
        if (markdown) {
            safeName = safeName.replaceFirst("(?i)(?:\\.lfh)?\\.json$", "");
            if (!safeName.toLowerCase(java.util.Locale.ROOT).endsWith(".md")) safeName += ".md";
        }
        return writeExportBytes(cacheDir, safeName,
            (content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
    }

    static File writeExportAttachment(File cacheDir, String fileName, byte[] content) throws IOException {
        return writeExportBytes(cacheDir, sanitizeFileName(fileName, "附件"), content);
    }

    private static File writeExportBytes(File cacheDir, String fileName, byte[] content) throws IOException {
        File exportDir = createExportDirectory(cacheDir);
        boolean written = false;
        try {
            File outFile = new File(exportDir, fileName);
            writeBytesAtomically(outFile, content);
            written = true;
            return outFile;
        } finally {
            if (!written) {
                exportDir.delete();
            }
        }
    }

    private static File createExportDirectory(File cacheDir) throws IOException {
        File exportsDir = new File(cacheDir, EXPORTS_DIR_NAME);
        ensureDirectory(exportsDir);
        while (true) {
            File exportDir = new File(exportsDir, UUID.randomUUID().toString());
            if (exportDir.mkdir()) {
                return exportDir;
            }
            if (!exportDir.exists()) {
                throw new IOException("无法创建存储目录: " + exportDir.getAbsolutePath());
            }
        }
    }

    static String sanitizeBackupFileName(String requested) {
        String base = sanitizeFileName(requested, DEFAULT_BACKUP_FILENAME);
        return base.toLowerCase(java.util.Locale.ROOT).endsWith(".json") ? base : base + ".lfh.json";
    }

    private static String sanitizeFileName(String requested, String fallback) {
        String base = requested == null ? "" : requested.trim();
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) {
            base = base.substring(slash + 1);
        }
        base = base.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F]+", "_").replace("..", "_");
        return base.isEmpty() || ".".equals(base) ? fallback : base;
    }
}
