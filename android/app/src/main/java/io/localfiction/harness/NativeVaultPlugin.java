package io.localfiction.harness;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

@CapacitorPlugin(name = "NativeVault")
public class NativeVaultPlugin extends Plugin {
    private static final String PREFS_NAME = "lfh_native_vault";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "lfh_api_key_master_aes256";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;

    private SecretVault secretVault;
    private PrivateStoryFileStore storyStore;

    @Override
    public void load() {
        Context context = getContext();
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        SecretVault.StringStore prefsStore = new SecretVault.StringStore() {
            @Override
            public String get(String key) {
                return prefs.getString(key, null);
            }

            @Override
            public void put(String key, String value) {
                prefs.edit().putString(key, value).commit();
            }

            @Override
            public void remove(String key) {
                prefs.edit().remove(key).commit();
            }
        };
        this.secretVault = new SecretVault(prefsStore, new AndroidKeystoreProvider());
        this.storyStore = new PrivateStoryFileStore(new File(context.getFilesDir(), "lfh_stories"));
    }

    @PluginMethod
    public void loadMeta(PluginCall call) {
        try {
            JSONObject meta = secretVault.loadMeta();
            JSObject result = new JSObject();
            result.put("meta", meta == null ? JSONObject.NULL : JSObject.fromJSONObject(meta));
            call.resolve(result);
        } catch (Exception err) {
            call.reject("读取模型配置元数据失败: " + err.getMessage(), err);
        }
    }

    @PluginMethod
    public void saveMeta(PluginCall call) {
        try {
            JSObject meta = new JSObject();
            meta.put("baseUrl", call.getString("baseUrl", ""));
            meta.put("model", call.getString("model", ""));
            meta.put("memoryOnly", call.getBoolean("memoryOnly", false));
            secretVault.saveMeta(meta);
            call.resolve();
        } catch (Exception err) {
            call.reject("保存模型配置元数据失败: " + err.getMessage(), err);
        }
    }

    @PluginMethod
    public void loadApiKey(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("apiKey", secretVault.loadApiKey());
            call.resolve(result);
        } catch (Exception err) {
            call.reject("读取加密 API Key 失败: " + err.getMessage(), err);
        }
    }

    @PluginMethod
    public void saveApiKey(PluginCall call) {
        try {
            String apiKey = call.getString("apiKey", "");
            secretVault.saveApiKey(apiKey);
            call.resolve();
        } catch (Exception err) {
            call.reject("加密保存 API Key 失败: " + err.getMessage(), err);
        }
    }

    @PluginMethod
    public void clearApiKey(PluginCall call) {
        secretVault.clearApiKey();
        call.resolve();
    }

    @PluginMethod
    public void listStories(PluginCall call) {
        try {
            List<JSONObject> stories = storyStore.listStories();
            JSArray arr = new JSArray();
            for (JSONObject story : stories) {
                arr.put(JSObject.fromJSONObject(story));
            }
            JSObject result = new JSObject();
            result.put("stories", arr);
            call.resolve(result);
        } catch (Exception err) {
            call.reject("读取本地故事列表失败: " + err.getMessage(), err);
        }
    }

    @PluginMethod
    public void getStory(PluginCall call) {
        String id = call.getString("id");
        try {
            JSONObject story = storyStore.getStory(id);
            JSObject result = new JSObject();
            result.put("story", story == null ? JSONObject.NULL : JSObject.fromJSONObject(story));
            call.resolve(result);
        } catch (Exception err) {
            call.reject("读取故事失败: " + err.getMessage(), err);
        }
    }

    @PluginMethod
    public void saveStory(PluginCall call) {
        JSObject storyObj = call.getObject("story");
        if (storyObj == null) {
            call.reject("story payload is required.");
            return;
        }
        try {
            storyStore.saveStory(storyObj, call.getLong("expectedUpdatedAt"));
            call.resolve();
        } catch (Exception err) {
            call.reject("保存故事失败: " + err.getMessage(), err);
        }
    }

    @PluginMethod
    public void deleteStory(PluginCall call) {
        String id = call.getString("id");
        try {
            storyStore.deleteStory(id);
            call.resolve();
        } catch (Exception err) {
            call.reject("删除故事失败: " + err.getMessage(), err);
        }
    }

    @PluginMethod
    public void getActiveStoryId(PluginCall call) {
        try {
            String activeId = storyStore.getActiveStoryId();
            JSObject result = new JSObject();
            result.put("id", activeId == null ? JSONObject.NULL : activeId);
            call.resolve(result);
        } catch (Exception err) {
            call.reject("读取当前激活故事 ID 失败: " + err.getMessage(), err);
        }
    }

    @PluginMethod
    public void setActiveStoryId(PluginCall call) {
        String id = call.getString("id");
        try {
            storyStore.setActiveStoryId(id);
            call.resolve();
        } catch (Exception err) {
            call.reject("设置激活故事 ID 失败: " + err.getMessage(), err);
        }
    }

    private static final Object WORKSPACE_LOCK = new Object();

    private File workspaceFile() {
        return new File(getContext().getFilesDir(), "lfh_creative_workspace.json");
    }

    @PluginMethod
    public void loadCreativeWorkspace(PluginCall call) {
        synchronized (WORKSPACE_LOCK) {
            try {
                JSObject result = new JSObject();
                File file = workspaceFile();
                result.put("workspace", file.exists()
                    ? new JSONObject(AtomicFileHelper.readUtf8File(file)) : JSONObject.NULL);
                call.resolve(result);
            } catch (Exception err) {
                call.reject("读取本地工作台失败。", err);
            }
        }
    }

    @PluginMethod
    public void saveCreativeWorkspace(PluginCall call) {
        synchronized (WORKSPACE_LOCK) {
            try {
                File file = workspaceFile();
                Integer expected = call.getInt("expected");
                JSObject workspace = call.getObject("workspace");
                int revision = file.exists()
                    ? new JSONObject(AtomicFileHelper.readUtf8File(file)).getInt("revision") : 0;
                if (expected == null || revision != expected || workspace == null
                    || workspace.getInt("revision") != expected + 1) {
                    call.reject("本地资料已变化，请重新打开后核对。");
                    return;
                }
                AtomicFileHelper.writeUtf8Atomically(file, workspace.toString());
                call.resolve();
            } catch (Exception err) {
                call.reject("保存本地工作台失败。", err);
            }
        }
    }

    @PluginMethod
    public void exportJsonFile(PluginCall call) {
        String fileName = call.getString("fileName", AtomicFileHelper.DEFAULT_BACKUP_FILENAME);
        String jsonContent = call.getString("jsonContent");
        if (jsonContent == null) {
            call.reject("jsonContent is required.");
            return;
        }
        try {
            Context context = getContext();
            String format = call.getString("format");
            boolean markdown = "markdown".equals(format);
            boolean attachment = "attachment".equals(format);
            File outFile = attachment
                ? AtomicFileHelper.writeExportAttachment(context.getCacheDir(), fileName, Base64.decode(jsonContent, Base64.DEFAULT))
                : AtomicFileHelper.writeExportFile(context.getCacheDir(), fileName, jsonContent, markdown);
            Uri uri = FileProvider.getUriForFile(
                context,
                context.getPackageName() + ".fileprovider",
                outFile
            );
            Intent sendIntent = new Intent(Intent.ACTION_SEND);
            sendIntent.setType(attachment ? "application/octet-stream" : markdown ? "text/markdown" : "application/json");
            sendIntent.putExtra(Intent.EXTRA_STREAM, uri);
            sendIntent.putExtra(Intent.EXTRA_SUBJECT, outFile.getName());
            sendIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooser = Intent.createChooser(sendIntent, attachment ? "保存附件" : markdown ? "导出 Markdown" : "导出故事 JSON 备份");
            Activity activity = getActivity();
            if (activity != null) {
                activity.runOnUiThread(() -> {
                    try {
                        activity.startActivity(chooser);
                        call.resolve();
                    } catch (Exception uiErr) {
                        call.reject("唤起系统分享面板失败: " + uiErr.getMessage(), uiErr);
                    }
                });
            } else {
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(chooser);
                call.resolve();
            }
        } catch (Exception err) {
            call.reject("导出 JSON 备份失败: " + err.getMessage(), err);
        }
    }

    private static final class AndroidKeystoreProvider implements SecretVault.KeyProvider {
        private synchronized SecretKey getOrCreateKey() throws Exception {
            KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
            ks.load(null);
            KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            }
            KeyGenerator keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
            keyGen.init(
                new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            );
            return keyGen.generateKey();
        }

        @Override
        public String encrypt(String plaintext) throws Exception {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] iv = cipher.getIV();
            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return Base64.encodeToString(iv, Base64.NO_WRAP)
                + ":"
                + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
        }

        @Override
        public String decrypt(String encryptedPayload) throws Exception {
            String[] parts = encryptedPayload.split(":", 2);
            if (parts.length != 2) {
                throw new IllegalStateException("加密凭据格式无效。");
            }
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        }
    }
}
