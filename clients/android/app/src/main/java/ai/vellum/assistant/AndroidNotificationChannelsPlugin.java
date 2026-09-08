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
     * channel is created here and stands in for any other channel a payload
     * names.
     */
    public static String resolveChannelId(Context context, String requestedChannelId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return requestedChannelId;
        }
        createAlertsChannel(context);
        if (
            ALERTS_CHANNEL_ID.equals(requestedChannelId)
                || channelExists(context, requestedChannelId)
        ) {
            return requestedChannelId;
        }
        NativeFailureGuard.record(
            "Android push named a notification channel that does not exist",
            new IllegalStateException(requestedChannelId)
        );
        return ALERTS_CHANNEL_ID;
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

    @RequiresApi(api = Build.VERSION_CODES.O)
    private static boolean channelExists(Context context, String channelId) {
        NotificationManager manager = manager(context);
        return manager != null && manager.getNotificationChannel(channelId) != null;
    }

    @Nullable
    private static NotificationManager manager(Context context) {
        return (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    }
}
