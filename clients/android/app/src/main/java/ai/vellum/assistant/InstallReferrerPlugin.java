package ai.vellum.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.RemoteException;
import com.android.installreferrer.api.InstallReferrerClient;
import com.android.installreferrer.api.InstallReferrerStateListener;
import com.android.installreferrer.api.ReferrerDetails;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Exposes the Play Store install referrer, the only attribution a Play install
 * carries. {@code read} never rejects: an empty result is the answer when no
 * Play Store answers, so a sideloaded build takes the same path as a Play
 * install with no campaign.
 */
@CapacitorPlugin(name = "InstallReferrer")
public class InstallReferrerPlugin extends Plugin {
    private static final String STATE_STORE = "install_referrer_state";
    private static final String INSTALL_BEGIN_TIMESTAMP_KEY = "install_begin_timestamp";
    private static final String REFERRER_KEY = "referrer";
    private static final String REFERRER_CLICK_TIMESTAMP_KEY = "referrer_click_timestamp";
    private static final String RESOLVED_KEY = "resolved";

    @PluginMethod
    public void read(PluginCall call) {
        SharedPreferences store = stateStore();
        if (store.getBoolean(RESOLVED_KEY, false)) {
            call.resolve(
                payload(
                    store.getString(REFERRER_KEY, ""),
                    store.getLong(REFERRER_CLICK_TIMESTAMP_KEY, 0L),
                    store.getLong(INSTALL_BEGIN_TIMESTAMP_KEY, 0L)
                )
            );
            return;
        }

        final InstallReferrerClient client = InstallReferrerClient.newBuilder(getContext()).build();
        // One connection can fire both setup-finished and service-disconnected,
        // and a call resolves once.
        final AtomicBoolean answered = new AtomicBoolean();
        try {
            client.startConnection(
                new InstallReferrerStateListener() {
                    @Override
                    public void onInstallReferrerSetupFinished(int responseCode) {
                        if (answered.getAndSet(true)) {
                            return;
                        }
                        JSObject result = new JSObject();
                        if (responseCode == InstallReferrerClient.InstallReferrerResponse.OK) {
                            result = readReferrer(client);
                        } else if (isTerminalStatus(responseCode)) {
                            cache("", 0L, 0L);
                        }
                        finish(client, call, result);
                    }

                    @Override
                    public void onInstallReferrerServiceDisconnected() {
                        if (!answered.getAndSet(true)) {
                            finish(client, call, new JSObject());
                        }
                    }
                }
            );
        } catch (RuntimeException exception) {
            NativeFailureGuard.record("Unable to bind the Play install referrer service", exception);
            if (!answered.getAndSet(true)) {
                finish(client, call, new JSObject());
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
        ReferrerDetails details;
        try {
            details = client.getInstallReferrer();
        } catch (RemoteException | RuntimeException exception) {
            NativeFailureGuard.record("Unable to read the Play install referrer", exception);
            return new JSObject();
        }
        String referrer = details.getInstallReferrer();
        long clickTimestamp = details.getReferrerClickTimestampSeconds();
        long beginTimestamp = details.getInstallBeginTimestampSeconds();
        cache(referrer, clickTimestamp, beginTimestamp);
        return payload(referrer, clickTimestamp, beginTimestamp);
    }

    private void finish(InstallReferrerClient client, PluginCall call, JSObject result) {
        NativeFailureGuard.run("Unable to close the Play install referrer connection", client::endConnection);
        call.resolve(result);
    }

    private void cache(String referrer, long clickTimestamp, long beginTimestamp) {
        stateStore()
            .edit()
            .putString(REFERRER_KEY, referrer == null ? "" : referrer)
            .putLong(REFERRER_CLICK_TIMESTAMP_KEY, clickTimestamp)
            .putLong(INSTALL_BEGIN_TIMESTAMP_KEY, beginTimestamp)
            .putBoolean(RESOLVED_KEY, true)
            .apply();
    }

    private SharedPreferences stateStore() {
        return getContext().getSharedPreferences(STATE_STORE, Context.MODE_PRIVATE);
    }

    private static JSObject payload(String referrer, long clickTimestamp, long beginTimestamp) {
        JSObject result = new JSObject();
        if (referrer == null || referrer.isEmpty()) {
            return result;
        }
        result.put("referrer", referrer);
        result.put("referrerClickTimestampSeconds", clickTimestamp);
        result.put("installBeginTimestampSeconds", beginTimestamp);
        return result;
    }
}
