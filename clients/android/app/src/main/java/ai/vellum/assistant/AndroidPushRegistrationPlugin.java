package ai.vellum.assistant;

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.function.Consumer;

@CapacitorPlugin(name = "AndroidPushRegistration")
public class AndroidPushRegistrationPlugin extends Plugin {
    private static final String FAILURE_CODE = "PUSH_REGISTRATION_FAILED";

    @PluginMethod
    public void register(PluginCall call) {
        invokeSafely(call, plugin -> plugin.register(call));
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        invokeSafely(call, plugin -> plugin.unregister(call));
    }

    private void invokeSafely(PluginCall call, Consumer<PushNotificationsPlugin> operation) {
        try {
            PushNotificationsPlugin plugin = PushNotificationsPlugin.getPushNotificationsInstance();
            if (plugin == null) {
                call.reject("Android push notifications are unavailable", FAILURE_CODE);
                return;
            }
            operation.accept(plugin);
        } catch (RuntimeException exception) {
            call.reject("Android push notifications are unavailable", FAILURE_CODE, exception);
        }
    }
}
