package ai.vellum.assistant;

import android.app.Activity;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.GeneralSecurityException;
import javax.crypto.Cipher;

@CapacitorPlugin(name = "NativeBiometric")
public class NativeBiometricPlugin extends Plugin {
    private static final String AUTH_CANCELED = "AUTH_CANCELED";
    private static final String AUTH_FAILED = "AUTH_FAILED";
    private static final String AUTH_IN_PROGRESS = "AUTH_IN_PROGRESS";
    private static final String BIOMETRIC_NOT_ENROLLED = "BIOMETRIC_NOT_ENROLLED";
    private static final String BIOMETRIC_UNAVAILABLE = "BIOMETRIC_UNAVAILABLE";
    private static final String KEY_INVALIDATED = "KEY_INVALIDATED";
    private static final String STORAGE_FAILED = "STORAGE_FAILED";
    private static final String TOKEN_NOT_FOUND = "TOKEN_NOT_FOUND";

    private final Object authenticationLock = new Object();

    private BiometricPrompt activePrompt;
    private PluginCall activeCall;
    private BiometricTokenStore tokenStore;

    private interface CipherFactory {
        Cipher create() throws GeneralSecurityException;
    }

    private interface AuthenticatedOperation {
        JSObject run(Cipher cipher) throws GeneralSecurityException;
    }

    @Override
    public void load() {
        try {
            tokenStore = new BiometricTokenStore(getContext());
        } catch (GeneralSecurityException ignored) {
            tokenStore = null;
        }
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        int status = biometricStatus();
        boolean available = status == BiometricManager.BIOMETRIC_SUCCESS && tokenStore != null;

        JSObject result = new JSObject();
        result.put("available", available);
        result.put("biometryType", available ? "biometric" : "none");
        call.resolve(result);
    }

    @PluginMethod
    public void storeToken(PluginCall call) {
        String token = requiredString(call, "token");
        String server = requiredString(call, "server");
        if (token == null || server == null || !requireStore(call)) {
            return;
        }

        authenticate(
            call,
            "Enable biometric sign-in",
            call.getString("reason", "Confirm your identity to enable biometric sign-in"),
            () -> tokenStore.prepareEncryption(server),
            cipher -> {
                tokenStore.store(server, token, cipher);
                return null;
            }
        );
    }

    @PluginMethod
    public void retrieveToken(PluginCall call) {
        String server = requiredString(call, "server");
        if (server == null) {
            return;
        }

        try {
            if (!requireStore(call)) {
                return;
            }
            if (!tokenStore.hasToken(server)) {
                call.reject("No stored token found", TOKEN_NOT_FOUND);
                return;
            }
        } catch (GeneralSecurityException e) {
            rejectStorageFailure(call, e);
            return;
        }

        authenticate(
            call,
            "Biometric sign-in",
            call.getString("reason", "Sign in to Vellum"),
            () -> tokenStore.prepareDecryption(server),
            cipher -> {
                JSObject result = new JSObject();
                result.put("token", tokenStore.retrieve(server, cipher));
                return result;
            }
        );
    }

    @PluginMethod
    public void deleteToken(PluginCall call) {
        String server = requiredString(call, "server");
        if (server == null) {
            return;
        }

        if (!requireStore(call)) {
            return;
        }
        try {
            tokenStore.delete(server);
            call.resolve();
        } catch (GeneralSecurityException e) {
            rejectStorageFailure(call, e);
        }
    }

    @Override
    protected void handleOnDestroy() {
        BiometricPrompt prompt;
        PluginCall call;
        synchronized (authenticationLock) {
            prompt = activePrompt;
            call = activeCall;
            activePrompt = null;
            activeCall = null;
        }
        if (prompt != null) {
            prompt.cancelAuthentication();
        }
        if (call != null) {
            call.reject("Authentication canceled", AUTH_CANCELED);
        }
    }

    private void authenticate(
        PluginCall call,
        String title,
        String reason,
        CipherFactory cipherFactory,
        AuthenticatedOperation operation
    ) {
        int status = biometricStatus();
        if (status != BiometricManager.BIOMETRIC_SUCCESS) {
            rejectUnavailable(call, status);
            return;
        }

        synchronized (authenticationLock) {
            if (activeCall != null) {
                call.reject("Another biometric request is already active", AUTH_IN_PROGRESS);
                return;
            }
            activeCall = call;
        }

        final Cipher cipher;
        try {
            cipher = cipherFactory.create();
        } catch (GeneralSecurityException e) {
            rejectActiveStorageFailure(call, e);
            return;
        }

        Activity activity = getActivity();
        if (!(activity instanceof FragmentActivity)) {
            finishReject(call, "No active screen is available for biometric authentication", BIOMETRIC_UNAVAILABLE, null);
            return;
        }

        FragmentActivity fragmentActivity = (FragmentActivity) activity;
        activity.runOnUiThread(() -> showPrompt(fragmentActivity, call, title, reason, cipher, operation));
    }

    private void showPrompt(
        FragmentActivity activity,
        PluginCall call,
        String title,
        String reason,
        Cipher cipher,
        AuthenticatedOperation operation
    ) {
        if (!isActive(call)) {
            return;
        }

        BiometricPrompt prompt = new BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationError(int errorCode, CharSequence errorMessage) {
                    rejectAuthenticationError(call, errorCode, errorMessage.toString());
                }

                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    Cipher authenticatedCipher = result.getCryptoObject() == null
                        ? null
                        : result.getCryptoObject().getCipher();
                    if (authenticatedCipher == null) {
                        finishReject(call, "Biometric authentication returned no cryptographic result", AUTH_FAILED, null);
                        return;
                    }

                    try {
                        finishResolve(call, operation.run(authenticatedCipher));
                    } catch (GeneralSecurityException e) {
                        rejectActiveStorageFailure(call, e);
                    }
                }
            }
        );

        synchronized (authenticationLock) {
            if (activeCall != call) {
                return;
            }
            activePrompt = prompt;
        }

        BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(reason)
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButtonText("Cancel")
            .build();

        prompt.authenticate(promptInfo, new BiometricPrompt.CryptoObject(cipher));
    }

    private boolean requireStore(PluginCall call) {
        if (tokenStore != null) {
            return true;
        }
        call.reject("Biometric storage is unavailable", BIOMETRIC_UNAVAILABLE);
        return false;
    }

    private int biometricStatus() {
        return BiometricManager.from(getContext())
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
    }

    private void rejectUnavailable(PluginCall call, int status) {
        String code = availabilityCode(status);
        JSObject data = new JSObject();
        data.put("available", false);
        data.put("biometryType", "none");
        data.put("recoverable", BIOMETRIC_NOT_ENROLLED.equals(code));
        call.reject(availabilityMessage(status), code, null, data);
    }

    private String availabilityCode(int status) {
        return status == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED
            ? BIOMETRIC_NOT_ENROLLED
            : BIOMETRIC_UNAVAILABLE;
    }

    private String availabilityMessage(int status) {
        if (status == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) {
            return "No strong biometric is enrolled";
        }
        if (status == BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE) {
            return "Biometric hardware is temporarily unavailable";
        }
        if (status == BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE) {
            return "This device has no supported biometric hardware";
        }
        if (status == BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED) {
            return "A security update is required for biometric authentication";
        }
        return "Strong biometric authentication is unavailable";
    }

    private void rejectAuthenticationError(PluginCall call, int errorCode, String message) {
        if (
            errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
            errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
            errorCode == BiometricPrompt.ERROR_CANCELED
        ) {
            finishReject(call, "Authentication canceled", AUTH_CANCELED, null);
            return;
        }
        if (errorCode == BiometricPrompt.ERROR_NO_BIOMETRICS) {
            finishReject(call, "No strong biometric is enrolled", BIOMETRIC_NOT_ENROLLED, null);
            return;
        }
        if (
            errorCode == BiometricPrompt.ERROR_HW_NOT_PRESENT ||
            errorCode == BiometricPrompt.ERROR_HW_UNAVAILABLE ||
            errorCode == BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED
        ) {
            finishReject(call, message, BIOMETRIC_UNAVAILABLE, null);
            return;
        }
        finishReject(call, message, AUTH_FAILED, null);
    }

    private void rejectActiveStorageFailure(PluginCall call, GeneralSecurityException error) {
        if (isInvalidated(error)) {
            try {
                String server = call.getString("server");
                if (server != null && tokenStore != null) {
                    tokenStore.delete(server);
                }
            } catch (GeneralSecurityException ignored) {
                // The unusable credential remains inaccessible.
            }
            JSObject data = new JSObject();
            data.put("recoverable", true);
            finishReject(call, "Biometric enrollment changed; enable biometric sign-in again", KEY_INVALIDATED, data);
            return;
        }
        if (error instanceof BiometricTokenStore.TokenNotFoundException) {
            finishReject(call, error.getMessage(), TOKEN_NOT_FOUND, null);
            return;
        }
        finishReject(call, "Biometric storage failed", STORAGE_FAILED, null);
    }

    private void rejectStorageFailure(PluginCall call, GeneralSecurityException error) {
        if (isInvalidated(error)) {
            JSObject data = new JSObject();
            data.put("recoverable", true);
            call.reject("Biometric enrollment changed; enable biometric sign-in again", KEY_INVALIDATED, error, data);
            return;
        }
        call.reject("Biometric storage failed", STORAGE_FAILED, error);
    }

    private boolean isInvalidated(Throwable error) {
        Throwable current = error;
        while (current != null) {
            if (
                current instanceof KeyPermanentlyInvalidatedException ||
                current instanceof BiometricTokenStore.MissingKeyException
            ) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    private String requiredString(PluginCall call, String name) {
        String value = call.getString(name);
        if (value == null || value.isEmpty()) {
            call.reject("Missing required option: " + name);
            return null;
        }
        return value;
    }

    private boolean isActive(PluginCall call) {
        synchronized (authenticationLock) {
            return activeCall == call;
        }
    }

    private void finishResolve(PluginCall call, JSObject result) {
        if (!clearActive(call)) {
            return;
        }
        if (result == null) {
            call.resolve();
        } else {
            call.resolve(result);
        }
    }

    private void finishReject(PluginCall call, String message, String code, JSObject data) {
        if (!clearActive(call)) {
            return;
        }
        call.reject(message, code, null, data);
    }

    private boolean clearActive(PluginCall call) {
        synchronized (authenticationLock) {
            if (activeCall != call) {
                return false;
            }
            activeCall = null;
            activePrompt = null;
            return true;
        }
    }
}
