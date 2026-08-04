package ai.vellum.assistant;

import android.Manifest;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

@CapacitorPlugin(
    name = "PushNotifications",
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "receive")
)
public class SafePushNotificationsPlugin extends PushNotificationsPlugin {
    private static final String FAILURE_CODE = "PUSH_REGISTRATION_FAILED";

    @Override
    @PluginMethod
    public void register(PluginCall call) {
        invokeSafely(call, () -> super.register(call));
    }

    @Override
    @PluginMethod
    public void unregister(PluginCall call) {
        invokeSafely(call, () -> super.unregister(call));
    }

    private void invokeSafely(PluginCall call, Runnable operation) {
        try {
            operation.run();
        } catch (RuntimeException exception) {
            call.reject("Android push notifications are unavailable", FAILURE_CODE, exception);
        }
    }
}
