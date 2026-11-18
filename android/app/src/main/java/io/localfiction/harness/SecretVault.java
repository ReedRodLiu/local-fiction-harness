package io.localfiction.harness;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Encrypted API key and model config metadata vault backed by an injected StringStore and KeyProvider.
 */
public class SecretVault {
    public static final String KEY_META = "lfh.model_config.meta";
    public static final String KEY_API_KEY = "lfh.model_config.api_key.enc";

    public interface StringStore {
        String get(String key);

        void put(String key, String value);

        void remove(String key);
    }

    public interface KeyProvider {
        String encrypt(String plaintext) throws Exception;

        String decrypt(String encryptedPayload) throws Exception;
    }

    private final Object lock = new Object();
    private final StringStore store;
    private final KeyProvider keyProvider;

    public SecretVault(StringStore store, KeyProvider keyProvider) {
        this.store = store;
        this.keyProvider = keyProvider;
    }

    public JSONObject loadMeta() throws JSONException {
        synchronized (lock) {
            String raw = store.get(KEY_META);
            if (raw == null || raw.isEmpty()) {
                return null;
            }
            return new JSONObject(raw);
        }
    }

    public void saveMeta(JSONObject meta) {
        synchronized (lock) {
            if (meta == null) {
                store.remove(KEY_META);
            } else {
                store.put(KEY_META, meta.toString());
                if (meta.optBoolean("memoryOnly", false)) {
                    store.remove(KEY_API_KEY);
                }
            }
        }
    }

    public String loadApiKey() throws Exception {
        synchronized (lock) {
            String encrypted = store.get(KEY_API_KEY);
            if (encrypted == null || encrypted.isEmpty()) {
                return "";
            }
            return keyProvider.decrypt(encrypted);
        }
    }

    public void saveApiKey(String apiKey) throws Exception {
        synchronized (lock) {
            if (apiKey == null || apiKey.isEmpty()) {
                store.remove(KEY_API_KEY);
                return;
            }
            String encrypted = keyProvider.encrypt(apiKey);
            store.put(KEY_API_KEY, encrypted);
        }
    }

    public void clearApiKey() {
        synchronized (lock) {
            store.remove(KEY_API_KEY);
        }
    }
}
