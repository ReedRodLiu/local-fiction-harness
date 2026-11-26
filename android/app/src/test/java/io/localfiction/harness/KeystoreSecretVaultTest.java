package io.localfiction.harness;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;
import org.junit.Test;

public class KeystoreSecretVaultTest {
    private static SecretVault.KeyProvider createInMemoryAesKeyProvider() throws Exception {
        KeyGenerator gen = KeyGenerator.getInstance("AES");
        gen.init(256);
        SecretKey key = gen.generateKey();
        SecureRandom rng = new SecureRandom();
        return new SecretVault.KeyProvider() {
            @Override
            public String encrypt(String plaintext) throws Exception {
                byte[] iv = new byte[12];
                rng.nextBytes(iv);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
                byte[] ct = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
                return java.util.Base64.getEncoder().encodeToString(iv)
                    + ":"
                    + java.util.Base64.getEncoder().encodeToString(ct);
            }

            @Override
            public String decrypt(String encryptedPayload) throws Exception {
                String[] parts = encryptedPayload.split(":", 2);
                byte[] iv = java.util.Base64.getDecoder().decode(parts[0]);
                byte[] ct = java.util.Base64.getDecoder().decode(parts[1]);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
                return new String(cipher.doFinal(ct), StandardCharsets.UTF_8);
            }
        };
    }

    @Test
    public void encryptsApiKeyAndImmediatelyPurgesOnClear() throws Exception {
        Map<String, String> backing = new HashMap<>();
        SecretVault.StringStore backingStore = new SecretVault.StringStore() {
            @Override
            public String get(String key) {
                return backing.get(key);
            }

            @Override
            public void put(String key, String value) {
                backing.put(key, value);
            }

            @Override
            public void remove(String key) {
                backing.remove(key);
            }
        };

        SecretVault vault = new SecretVault(backingStore, createInMemoryAesKeyProvider());
        assertNull(vault.loadMeta());
        assertEquals("", vault.loadApiKey());

        JSONObject meta = new JSONObject()
            .put("baseUrl", "https://api.deepseek.com")
            .put("model", "deepseek-chat")
            .put("memoryOnly", false);
        vault.saveMeta(meta);
        vault.saveApiKey("sk-secret-android-999");

        // Backing store must NOT hold plaintext API key
        for (String val : backing.values()) {
            assertFalse(val.contains("sk-secret-android-999"));
        }

        assertEquals("https://api.deepseek.com", vault.loadMeta().getString("baseUrl"));
        assertEquals("sk-secret-android-999", vault.loadApiKey());

        vault.clearApiKey();
        assertEquals("", vault.loadApiKey());
        assertFalse(backing.containsKey(SecretVault.KEY_API_KEY));

        // Saving meta with memoryOnly=true also purges any persisted key defensively
        vault.saveApiKey("sk-temp-purge");
        assertEquals("sk-temp-purge", vault.loadApiKey());
        vault.saveMeta(new JSONObject()
            .put("baseUrl", "https://api.deepseek.com")
            .put("model", "deepseek-chat")
            .put("memoryOnly", true));
        assertEquals("", vault.loadApiKey());
        assertFalse(backing.containsKey(SecretVault.KEY_API_KEY));
    }

    @Test
    public void roundTripsMultiProviderLibraryMetaAndV2SecretEnvelope() throws Exception {
        Map<String, String> backing = new HashMap<>();
        SecretVault.StringStore backingStore = new SecretVault.StringStore() {
            @Override
            public String get(String key) {
                return backing.get(key);
            }

            @Override
            public void put(String key, String value) {
                backing.put(key, value);
            }

            @Override
            public void remove(String key) {
                backing.remove(key);
            }
        };

        SecretVault vault = new SecretVault(backingStore, createInMemoryAesKeyProvider());

        JSONObject deepseekProfile = new JSONObject()
            .put("id", "ds-1")
            .put("name", "DeepSeek 官方")
            .put("presetId", "deepseek")
            .put("baseUrl", "https://api.deepseek.com")
            .put("defaultModel", "deepseek-flash")
            .put("backgroundModel", "deepseek-flash");

        JSONObject openaiProfile = new JSONObject()
            .put("id", "openai-1")
            .put("name", "OpenAI")
            .put("presetId", "openai")
            .put("baseUrl", "https://api.openai.com/v1")
            .put("defaultModel", "gpt-4o");

        JSONObject providerLibrary = new JSONObject()
            .put("version", 2)
            .put("activeProviderId", "openai-1")
            .put("reasoningEffort", "medium")
            .put("profiles", new org.json.JSONArray().put(deepseekProfile).put(openaiProfile))
            .put("publicResearch", new JSONObject().put("provider", "tavily"));

        JSONObject rawInputMeta = new JSONObject()
            .put("providerId", "openai-1")
            .put("providerPresetId", "openai")
            .put("reasoningEffort", "medium")
            .put("providerLibrary", providerLibrary);

        JSONObject normalizedMeta = NativeVaultPlugin.normalizeMetaPayload(rawInputMeta);
        assertEquals("", normalizedMeta.getString("baseUrl"));
        assertEquals("", normalizedMeta.getString("model"));
        assertFalse(normalizedMeta.getBoolean("memoryOnly"));

        vault.saveMeta(normalizedMeta);
        String envelope = "lfh-secrets-v2:{\"providers\":{\"ds-1\":\"sk-ds-vault\",\"openai-1\":\"sk-openai-vault\"},\"searchApiKey\":\"tvly-vault-1\"}";
        vault.saveApiKey(envelope);

        for (String val : backing.values()) {
            assertFalse(val.contains("sk-ds-vault"));
            assertFalse(val.contains("sk-openai-vault"));
            assertFalse(val.contains("tvly-vault-1"));
        }

        JSONObject loadedMeta = vault.loadMeta();
        JSONObject loadedLibrary = loadedMeta.getJSONObject("providerLibrary");
        assertEquals(2, loadedLibrary.getInt("version"));
        assertEquals("openai-1", loadedLibrary.getString("activeProviderId"));
        assertEquals("medium", loadedLibrary.getString("reasoningEffort"));
        assertEquals(2, loadedLibrary.getJSONArray("profiles").length());
        assertEquals("tavily", loadedLibrary.getJSONObject("publicResearch").getString("provider"));
        assertEquals(envelope, vault.loadApiKey());
    }
}
