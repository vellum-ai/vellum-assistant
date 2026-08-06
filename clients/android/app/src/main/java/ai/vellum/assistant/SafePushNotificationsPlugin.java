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
    @Override
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        PushRegistrationGuard.run(call, () -> super.checkPermissions(call));
    }

    @Override
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        PushRegistrationGuard.run(call, () -> super.requestPermissions(call));
    }

    @Override
    @PluginMethod
    public void register(PluginCall call) {
        PushRegistrationGuard.run(call, () -> super.register(call));
    }

    @Override
    @PluginMethod
    public void unregister(PluginCall call) {
        PushRegistrationGuard.run(call, () -> super.unregister(call));
    }
}
