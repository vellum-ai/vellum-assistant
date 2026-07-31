package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;

import java.security.GeneralSecurityException;
import java.util.HashMap;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.junit.Test;

public class BiometricTokenStoreTest {
    private static final String SERVER = "https://example.com";

    @Test
    public void encryptsAndRetrievesToken() throws Exception {
        MemoryKeyProvider keys = new MemoryKeyProvider();
        MemoryPayloadStore payloads = new MemoryPayloadStore();
        BiometricTokenStore store = new BiometricTokenStore(keys, payloads);

        Cipher encryption = store.prepareEncryption(SERVER);
        store.store(SERVER, "session-token-123", encryption);

        Cipher decryption = store.prepareDecryption(SERVER);
        assertEquals("session-token-123", store.retrieve(SERVER, decryption));
    }

    @Test
    public void isolatesTokensByServer() throws Exception {
        BiometricTokenStore store = new BiometricTokenStore(
            new MemoryKeyProvider(),
            new MemoryPayloadStore()
        );
        String otherServer = "https://assistant.example.org";

        store.store(SERVER, "token-one", store.prepareEncryption(SERVER));
        store.store(otherServer, "token-two", store.prepareEncryption(otherServer));

        assertNotEquals(
            BiometricTokenStore.storageKey(SERVER),
            BiometricTokenStore.storageKey(otherServer)
        );
        assertEquals("token-one", store.retrieve(SERVER, store.prepareDecryption(SERVER)));
        assertEquals("token-two", store.retrieve(otherServer, store.prepareDecryption(otherServer)));
    }

    @Test
    public void deletesCiphertextAndKey() throws Exception {
        MemoryKeyProvider keys = new MemoryKeyProvider();
        BiometricTokenStore store = new BiometricTokenStore(keys, new MemoryPayloadStore());

        store.store(SERVER, "session-token-123", store.prepareEncryption(SERVER));
        store.delete(SERVER);
        store.delete(SERVER);

        assertFalse(store.hasToken(SERVER));
        assertEquals(0, keys.size());
    }

    @Test
    public void reportsMissingKeyForStoredCiphertext() throws Exception {
        MemoryKeyProvider keys = new MemoryKeyProvider();
        BiometricTokenStore store = new BiometricTokenStore(keys, new MemoryPayloadStore());

        store.store(SERVER, "session-token-123", store.prepareEncryption(SERVER));
        keys.clear();

        assertThrows(
            BiometricTokenStore.MissingKeyException.class,
            () -> store.prepareDecryption(SERVER)
        );
    }

    private static final class MemoryKeyProvider implements BiometricTokenStore.KeyProvider {
        private final Map<String, SecretKey> keys = new HashMap<>();

        @Override
        public SecretKey getOrCreate(String alias) throws GeneralSecurityException {
            SecretKey existing = keys.get(alias);
            if (existing != null) {
                return existing;
            }
            KeyGenerator generator = KeyGenerator.getInstance("AES");
            generator.init(256);
            SecretKey key = generator.generateKey();
            keys.put(alias, key);
            return key;
        }

        @Override
        public SecretKey get(String alias) {
            return keys.get(alias);
        }

        @Override
        public void delete(String alias) {
            keys.remove(alias);
        }

        int size() {
            return keys.size();
        }

        void clear() {
            keys.clear();
        }
    }

    private static final class MemoryPayloadStore implements BiometricTokenStore.PayloadStore {
        private final Map<String, BiometricTokenStore.EncryptedPayload> payloads = new HashMap<>();

        @Override
        public BiometricTokenStore.EncryptedPayload get(String key) {
            return payloads.get(key);
        }

        @Override
        public void put(String key, BiometricTokenStore.EncryptedPayload payload) {
            payloads.put(key, payload);
        }

        @Override
        public void delete(String key) {
            payloads.remove(key);
        }
    }
}
