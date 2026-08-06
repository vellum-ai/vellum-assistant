package ai.vellum.assistant;

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.function.Consumer;

@CapacitorPlugin(name = "AndroidPushRegistration")
public class AndroidPushRegistrationPlugin extends Plugin {
    @PluginMethod
    public void register(PluginCall call) {
        invokeSafely(call, plugin -> plugin.register(call));
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        invokeSafely(call, plugin -> plugin.unregister(call));
    }

    private void invokeSafely(PluginCall call, Consumer<PushNotificationsPlugin> operation) {
        PushRegistrationGuard.call(call, () -> {
            PushNotificationsPlugin plugin = PushNotificationsPlugin.getPushNotificationsInstance();
            if (plugin == null) {
                PushRegistrationGuard.reject(call);
                return;
            }
            operation.accept(plugin);
        });
    }
}
