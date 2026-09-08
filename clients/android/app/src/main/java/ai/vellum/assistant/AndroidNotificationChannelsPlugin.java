package ai.vellum.assistant;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AndroidNotificationChannels")
public class AndroidNotificationChannelsPlugin extends Plugin {
    public static final String ALERTS_CHANNEL_ID = "vellum-alerts";

    private static final String ALERTS_CHANNEL_NAME = "Alerts";
    private static final String FAILURE_CODE = "NOTIFICATION_CHANNEL_FAILED";
    private static final String FAILURE_MESSAGE = "Android notification channels are unavailable";

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
     * The channel a natively rendered push posts on. A push can arrive before
     * the web runtime has ever asked for the alerts channel, and from API 26
     * posting to a channel that does not exist is a silent no-op, so the
     * channel is created here and stands in for any channel a payload names
     * that is not one of ours to alert on.
     */
    public static String resolveChannelId(Context context, String requestedChannelId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            createAlertsChannel(context);
        }
        if (isAlertChannelId(requestedChannelId)) {
            return requestedChannelId;
        }
        NativeFailureGuard.record(
            "Android push named a channel that does not alert",
            new IllegalStateException(requestedChannelId)
        );
        return ALERTS_CHANNEL_ID;
    }

    /**
     * Existing is not enough: the voice session channel and Firebase's own
     * fallback both exist and both post silently and without a badge, so a
     * payload can only name a channel this app alerts on.
     */
    static boolean isAlertChannelId(@Nullable String channelId) {
        return ALERTS_CHANNEL_ID.equals(channelId);
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
