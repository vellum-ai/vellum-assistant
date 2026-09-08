package ai.vellum.assistant;

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.function.Consumer;

@CapacitorPlugin(name = "AndroidPushRegistration")
public class AndroidPushRegistrationPlugin extends Plugin {
    /**
     * Advertised on token registration. The platform sends data-only pushes
     * only to tokens claiming this, so a build that cannot render them
     * natively must never claim it.
     */
    static final String NATIVE_NOTIFICATION_RENDER = "native-notification-render";

    @PluginMethod
    public void register(PluginCall call) {
        invokeSafely(call, plugin -> plugin.register(call));
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        invokeSafely(call, plugin -> plugin.unregister(call));
    }

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        call.resolve(capabilitiesPayload());
    }

    static JSObject capabilitiesPayload() {
        JSArray capabilities = new JSArray();
        capabilities.put(NATIVE_NOTIFICATION_RENDER);
        JSObject payload = new JSObject();
        payload.put("capabilities", capabilities);
        return payload;
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
