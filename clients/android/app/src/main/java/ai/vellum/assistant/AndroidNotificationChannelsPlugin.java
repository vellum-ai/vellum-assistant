package ai.vellum.assistant;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AndroidNotificationChannels")
public class AndroidNotificationChannelsPlugin extends Plugin {
    private static final String ALERTS_CHANNEL_ID = "vellum-alerts";
    private static final String FAILURE_CODE = "NOTIFICATION_CHANNEL_FAILED";
    private static final String FAILURE_MESSAGE = "Android notification channels are unavailable";

    @PluginMethod
    public void ensureAlertsChannel(PluginCall call) {
        NativeFailureGuard.call(call, FAILURE_MESSAGE, FAILURE_CODE, () -> {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                call.resolve();
                return;
            }
            NotificationManager manager = (NotificationManager) getContext()
                .getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) {
                call.reject(FAILURE_MESSAGE, FAILURE_CODE);
                return;
            }
            NotificationChannel channel = new NotificationChannel(
                ALERTS_CHANNEL_ID,
                "Alerts",
                NotificationManager.IMPORTANCE_DEFAULT
            );
            manager.createNotificationChannel(channel);
            call.resolve();
        });
    }
}
