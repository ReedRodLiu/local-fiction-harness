package io.localfiction.harness;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class AtomicFileHelperTest {
    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    @Test
    public void repeatedExportsKeepTheirOwnBytesAndOriginalNames() throws Exception {
        File cacheDir = tempFolder.newFolder("exports-cache");

        File firstAnonymousConversation = AtomicFileHelper.writeExportFile(
            cacheDir, "匿名对话.md", "第一份对话", true);
        File secondAnonymousConversation = AtomicFileHelper.writeExportFile(
            cacheDir, "匿名对话.md", "第二份对话", true);
        assertEquals("匿名对话.md", firstAnonymousConversation.getName());
        assertEquals(firstAnonymousConversation.getName(), secondAnonymousConversation.getName());
        assertDifferentPaths(firstAnonymousConversation, secondAnonymousConversation);
        assertInExportsRoot(cacheDir, firstAnonymousConversation);
        assertInExportsRoot(cacheDir, secondAnonymousConversation);
        assertEquals("第一份对话", readUtf8(firstAnonymousConversation));
        assertEquals("第二份对话", readUtf8(secondAnonymousConversation));

        File firstBackup = AtomicFileHelper.writeExportBackupFile(cacheDir, "故事.lfh.json", "第一份备份");
        File secondBackup = AtomicFileHelper.writeExportBackupFile(cacheDir, "故事.lfh.json", "第二份备份");
        assertEquals("故事.lfh.json", firstBackup.getName());
        assertDifferentPaths(firstBackup, secondBackup);
        assertInExportsRoot(cacheDir, firstBackup);
        assertInExportsRoot(cacheDir, secondBackup);
        assertEquals("第一份备份", readUtf8(firstBackup));
        assertEquals("第二份备份", readUtf8(secondBackup));

        byte[] firstAttachmentBytes = new byte[] {0, (byte) 255, 42};
        byte[] secondAttachmentBytes = new byte[] {9, 8, 7};
        File firstAttachment = AtomicFileHelper.writeExportAttachment(cacheDir, "附件.bin", firstAttachmentBytes);
        File secondAttachment = AtomicFileHelper.writeExportAttachment(cacheDir, "附件.bin", secondAttachmentBytes);
        assertEquals("附件.bin", firstAttachment.getName());
        assertDifferentPaths(firstAttachment, secondAttachment);
        assertInExportsRoot(cacheDir, firstAttachment);
        assertInExportsRoot(cacheDir, secondAttachment);
        assertArrayEquals(firstAttachmentBytes, Files.readAllBytes(firstAttachment.toPath()));
        assertArrayEquals(secondAttachmentBytes, Files.readAllBytes(secondAttachment.toPath()));
    }

    @Test
    public void failedExportRemovesItsTemporaryCacheDirectory() throws Exception {
        File cacheDir = tempFolder.newFolder("failed-export-cache");

        try {
            AtomicFileHelper.writeExportAttachment(cacheDir, "失败.bin", null);
            fail("Expected null attachment content to fail");
        } catch (NullPointerException expected) {
            // The helper must still remove the private export directory it created.
        }

        File[] remainingExports = new File(cacheDir, "exports").listFiles();
        assertNotNull(remainingExports);
        assertEquals(0, remainingExports.length);
    }

    private static void assertDifferentPaths(File first, File second) throws Exception {
        assertNotEquals(first.getCanonicalPath(), second.getCanonicalPath());
    }

    private static void assertInExportsRoot(File cacheDir, File exportedFile) throws Exception {
        File exportsRoot = new File(cacheDir, "exports").getCanonicalFile();
        assertEquals(exportsRoot, exportedFile.getParentFile().getParentFile().getCanonicalFile());
    }

    private static String readUtf8(File file) throws Exception {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }
}
