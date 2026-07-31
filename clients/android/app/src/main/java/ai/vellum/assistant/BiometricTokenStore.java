package ai.vellum.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class BiometricTokenStore {
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String CIPHER_TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String KEY_ALIAS_PREFIX = "vellum-biometric-";
    private static final String PREFERENCES_NAME = "native_biometric_tokens";
    private static final int GCM_TAG_LENGTH_BITS = 128;
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    interface KeyProvider {
        SecretKey getOrCreate(String alias) throws GeneralSecurityException;

        SecretKey get(String alias) throws GeneralSecurityException;

        void delete(String alias) throws GeneralSecurityException;
    }

    interface PayloadStore {
        EncryptedPayload get(String key) throws GeneralSecurityException;

        void put(String key, EncryptedPayload payload) throws GeneralSecurityException;

        void delete(String key) throws GeneralSecurityException;
    }

    static final class EncryptedPayload {
        final byte[] iv;
        final byte[] ciphertext;

        EncryptedPayload(byte[] iv, byte[] ciphertext) {
            this.iv = iv.clone();
            this.ciphertext = ciphertext.clone();
        }
    }

    static final class TokenNotFoundException extends GeneralSecurityException {
        TokenNotFoundException() {
            super("No stored token found");
        }
    }

    static final class MissingKeyException extends GeneralSecurityException {
        MissingKeyException() {
            super("The biometric key is unavailable");
        }
    }

    private final KeyProvider keyProvider;
    private final PayloadStore payloadStore;

    BiometricTokenStore(Context context) throws GeneralSecurityException {
        this(
            new AndroidKeyProvider(),
            new SharedPreferencesPayloadStore(
                context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
            )
        );
    }

    BiometricTokenStore(KeyProvider keyProvider, PayloadStore payloadStore) {
        this.keyProvider = keyProvider;
        this.payloadStore = payloadStore;
    }

    boolean hasToken(String server) throws GeneralSecurityException {
        return payloadStore.get(storageKey(server)) != null;
    }

    Cipher prepareEncryption(String server) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, keyProvider.getOrCreate(keyAlias(server)));
        return cipher;
    }

    Cipher prepareDecryption(String server) throws GeneralSecurityException {
        EncryptedPayload payload = payloadStore.get(storageKey(server));
        if (payload == null) {
            throw new TokenNotFoundException();
        }

        SecretKey key = keyProvider.get(keyAlias(server));
        if (key == null) {
            throw new MissingKeyException();
        }

        Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, payload.iv));
        return cipher;
    }

    void store(String server, String token, Cipher authenticatedCipher) throws GeneralSecurityException {
        byte[] ciphertext = authenticatedCipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        payloadStore.put(
            storageKey(server),
            new EncryptedPayload(authenticatedCipher.getIV(), ciphertext)
        );
    }

    String retrieve(String server, Cipher authenticatedCipher) throws GeneralSecurityException {
        EncryptedPayload payload = payloadStore.get(storageKey(server));
        if (payload == null) {
            throw new TokenNotFoundException();
        }
        byte[] plaintext = authenticatedCipher.doFinal(payload.ciphertext);
        return new String(plaintext, StandardCharsets.UTF_8);
    }

    void delete(String server) throws GeneralSecurityException {
        payloadStore.delete(storageKey(server));
        keyProvider.delete(keyAlias(server));
    }

    static String storageKey(String server) throws GeneralSecurityException {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(server.getBytes(StandardCharsets.UTF_8));
        char[] encoded = new char[hash.length * 2];
        for (int index = 0; index < hash.length; index++) {
            int value = hash[index] & 0xff;
            encoded[index * 2] = HEX[value >>> 4];
            encoded[index * 2 + 1] = HEX[value & 0x0f];
        }
        return new String(encoded);
    }

    private static String keyAlias(String server) throws GeneralSecurityException {
        return KEY_ALIAS_PREFIX + storageKey(server);
    }

    private static final class AndroidKeyProvider implements KeyProvider {
        private final KeyStore keyStore;

        AndroidKeyProvider() throws GeneralSecurityException {
            keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
            try {
                keyStore.load(null);
            } catch (java.io.IOException e) {
                throw new GeneralSecurityException("Failed to load Android Keystore", e);
            }
        }

        @Override
        public synchronized SecretKey getOrCreate(String alias) throws GeneralSecurityException {
            SecretKey existing = get(alias);
            if (existing != null) {
                return existing;
            }

            KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
            KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
            } else {
                spec.setUserAuthenticationValidityDurationSeconds(-1);
            }

            keyGenerator.init(spec.build());
            return keyGenerator.generateKey();
        }

        @Override
        public synchronized SecretKey get(String alias) throws GeneralSecurityException {
            java.security.Key key = keyStore.getKey(alias, null);
            return key instanceof SecretKey ? (SecretKey) key : null;
        }

        @Override
        public synchronized void delete(String alias) throws GeneralSecurityException {
            if (keyStore.containsAlias(alias)) {
                keyStore.deleteEntry(alias);
            }
        }
    }

    private static final class SharedPreferencesPayloadStore implements PayloadStore {
        private static final String CIPHERTEXT_SUFFIX = ".ciphertext";
        private static final String IV_SUFFIX = ".iv";

        private final SharedPreferences preferences;

        SharedPreferencesPayloadStore(SharedPreferences preferences) {
            this.preferences = preferences;
        }

        @Override
        public EncryptedPayload get(String key) throws GeneralSecurityException {
            String iv = preferences.getString(key + IV_SUFFIX, null);
            String ciphertext = preferences.getString(key + CIPHERTEXT_SUFFIX, null);
            if (iv == null || ciphertext == null) {
                return null;
            }
            try {
                return new EncryptedPayload(
                    Base64.decode(iv, Base64.NO_WRAP),
                    Base64.decode(ciphertext, Base64.NO_WRAP)
                );
            } catch (IllegalArgumentException e) {
                throw new GeneralSecurityException("Stored biometric data is invalid", e);
            }
        }

        @Override
        public void put(String key, EncryptedPayload payload) throws GeneralSecurityException {
            boolean committed = preferences.edit()
                .putString(key + IV_SUFFIX, Base64.encodeToString(payload.iv, Base64.NO_WRAP))
                .putString(
                    key + CIPHERTEXT_SUFFIX,
                    Base64.encodeToString(payload.ciphertext, Base64.NO_WRAP)
                )
                .commit();
            if (!committed) {
                throw new GeneralSecurityException("Failed to persist biometric data");
            }
        }

        @Override
        public void delete(String key) throws GeneralSecurityException {
            boolean committed = preferences.edit()
                .remove(key + IV_SUFFIX)
                .remove(key + CIPHERTEXT_SUFFIX)
                .commit();
            if (!committed) {
                throw new GeneralSecurityException("Failed to delete biometric data");
            }
        }
    }
}
