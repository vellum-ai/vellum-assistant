package ai.vellum.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.RemoteException;
import com.android.installreferrer.api.InstallReferrerClient;
import com.android.installreferrer.api.InstallReferrerStateListener;
import com.android.installreferrer.api.ReferrerDetails;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Exposes the Play Store install referrer, the only attribution a Play install
 * carries. {@code read} never rejects: an empty result is the answer when no
 * Play Store answers, so a sideloaded build takes the same path as a Play
 * install with no campaign. Failures are logged, never reported: an absent or
 * uncooperative Play Store is the normal state in development.
 */
@CapacitorPlugin(name = "InstallReferrer")
public class InstallReferrerPlugin extends Plugin {
    private static final String STATE_STORE = "install_referrer_state";
    private static final String REFERRER_KEY = "referrer";
    private static final String RESOLVED_KEY = "resolved";

    /**
     * Bound on the service bind, and the only bound on this read: the web layer
     * awaits the call on the auth critical path, ahead of the sign-in sheet. A
     * bind that connects but never calls back resolves empty here, uncached, so
     * a later launch retries.
     */
    private static final long BIND_TIMEOUT_MS = 2500L;

    @PluginMethod
    public void read(PluginCall call) {
        SharedPreferences store = stateStore();
        if (store.getBoolean(RESOLVED_KEY, false)) {
            call.resolve(payload(store.getString(REFERRER_KEY, "")));
            return;
        }

        // One connection can fire both setup-finished and service-disconnected,
        // and a call resolves once.
        final AtomicBoolean answered = new AtomicBoolean();
        // The timeout is armed before the client is built, so a build that
        // throws or hangs still leaves something to answer the call.
        final AtomicReference<InstallReferrerClient> clientRef = new AtomicReference<>();
        final Handler timeoutHandler = new Handler(Looper.getMainLooper());
        timeoutHandler.postDelayed(
            () -> {
                if (!answered.getAndSet(true)) {
                    finish(clientRef.get(), call, new JSObject(), timeoutHandler);
                }
            },
            BIND_TIMEOUT_MS
        );
        try {
            final InstallReferrerClient client = InstallReferrerClient.newBuilder(getContext()).build();
            clientRef.set(client);
            client.startConnection(
                new InstallReferrerStateListener() {
                    @Override
                    public void onInstallReferrerSetupFinished(int responseCode) {
                        if (answered.getAndSet(true)) {
                            return;
                        }
                        // The single-resolve guard is spent, so only this
                        // branch can answer. Capacitor turns a throw here into
                        // a log, never a rejection.
                        JSObject result = new JSObject();
                        try {
                            if (responseCode == InstallReferrerClient.InstallReferrerResponse.OK) {
                                result = readReferrer(client);
                            } else if (isTerminalStatus(responseCode)) {
                                cache("");
                            }
                        } catch (RuntimeException exception) {
                            Logger.error("Unable to resolve the Play install referrer", exception);
                        } finally {
                            finish(client, call, result, timeoutHandler);
                        }
                    }

                    @Override
                    public void onInstallReferrerServiceDisconnected() {
                        if (!answered.getAndSet(true)) {
                            finish(client, call, new JSObject(), timeoutHandler);
                        }
                    }
                }
            );
        } catch (RuntimeException exception) {
            Logger.error("Unable to bind the Play install referrer service", exception);
            if (!answered.getAndSet(true)) {
                finish(clientRef.get(), call, new JSObject(), timeoutHandler);
            }
        }
    }

    /**
     * Whether a status means the Play Store on this device will never answer, so
     * the miss is worth caching. Transient statuses stay uncached, leaving a
     * later launch free to retry.
     */
    static boolean isTerminalStatus(int responseCode) {
        return (
            responseCode == InstallReferrerClient.InstallReferrerResponse.FEATURE_NOT_SUPPORTED ||
            responseCode == InstallReferrerClient.InstallReferrerResponse.DEVELOPER_ERROR
        );
    }

    private JSObject readReferrer(InstallReferrerClient client) {
        String referrer;
        try {
            // A malfunctioning Play Store can hand back a null bundle.
            ReferrerDetails details = client.getInstallReferrer();
            referrer = details.getInstallReferrer();
        } catch (RemoteException | RuntimeException exception) {
            Logger.error("Unable to read the Play install referrer", exception);
            return new JSObject();
        }
        cache(referrer);
        return payload(referrer);
    }

    /** Resolves the call whatever happened, so nothing leaves it pending. */
    private void finish(InstallReferrerClient client, PluginCall call, JSObject result, Handler timeoutHandler) {
        try {
            timeoutHandler.removeCallbacksAndMessages(null);
            if (client != null) {
                client.endConnection();
            }
        } catch (RuntimeException exception) {
            Logger.error("Unable to close the Play install referrer connection", exception);
        }
        call.resolve(result);
    }

    private void cache(String referrer) {
        stateStore()
            .edit()
            .putString(REFERRER_KEY, referrer == null ? "" : referrer)
            .putBoolean(RESOLVED_KEY, true)
            .apply();
    }

    private SharedPreferences stateStore() {
        return getContext().getSharedPreferences(STATE_STORE, Context.MODE_PRIVATE);
    }

    private static JSObject payload(String referrer) {
        JSObject result = new JSObject();
        if (referrer == null || referrer.isEmpty()) {
            return result;
        }
        result.put("referrer", referrer);
        return result;
    }
}
