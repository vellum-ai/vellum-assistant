package ai.vellum.assistant;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashSet;
import java.util.Set;

@CapacitorPlugin(name = "AndroidNotificationChannels")
public class AndroidNotificationChannelsPlugin extends Plugin {
    public static final String ALERTS_CHANNEL_ID = "vellum-alerts";

    private static final String ALERTS_CHANNEL_NAME = "Alerts";
    private static final String FAILURE_CODE = "NOTIFICATION_CHANNEL_FAILED";
    private static final String FAILURE_MESSAGE = "Android notification channels are unavailable";
    /**
     * A payload picks the channel id, so the warned set is capped: an unknown
     * name is a platform bug worth one line, never a growing map keyed by
     * whatever arrives.
     */
    private static final int MAX_WARNED_CHANNEL_IDS = 16;

    private static final Set<String> warnedChannelIds = new HashSet<>();

    @PluginMethod
    public void ensureAlertsChannel(PluginCall call) {
        NativeFailureGuard.call(call, FAILURE_MESSAGE, FAILURE_CODE, () -> {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                call.resolve();
                return;
            }
            if (!createAlertsChannel(getContext())) {
                call.reject(FAILURE_MESSAGE, FAILURE_CODE);
                return;
            }
            call.resolve();
        });
    }

    /**
     * Creates the channel a natively rendered push posts on. A push can arrive
     * before the web runtime has ever asked for the alerts channel, and from
     * API 26 posting to a channel that does not exist is a silent no-op.
     *
     * <p>{@link #ALERTS_CHANNEL_ID} is also the only channel a payload may
     * name, so a push naming another still posts here. Existing is not enough:
     * the voice session channel and Firebase's own fallback both exist and both
     * post silently and without a badge.
     */
    public static void ensureAlertsChannel(Context context, @Nullable String requestedChannelId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            createAlertsChannel(context);
        }
        if (firstWarningFor(requestedChannelId)) {
            Logger.warn("Android push named a channel that does not alert: " + requestedChannelId);
        }
    }

    /** One line per unrecognized channel id, which is a platform bug, not a user's problem. */
    static synchronized boolean firstWarningFor(@Nullable String channelId) {
        if (ALERTS_CHANNEL_ID.equals(channelId)) {
            return false;
        }
        return warnedChannelIds.size() < MAX_WARNED_CHANNEL_IDS
            && warnedChannelIds.add(String.valueOf(channelId));
    }

    @RequiresApi(api = Build.VERSION_CODES.O)
    private static boolean createAlertsChannel(Context context) {
        NotificationManager manager = manager(context);
        if (manager == null) {
            return false;
        }
        manager.createNotificationChannel(
            new NotificationChannel(
                ALERTS_CHANNEL_ID,
                ALERTS_CHANNEL_NAME,
                NotificationManager.IMPORTANCE_DEFAULT
            )
        );
        return true;
    }

    @Nullable
    private static NotificationManager manager(Context context) {
        return (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    }
}
