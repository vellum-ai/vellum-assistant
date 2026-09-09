package ai.vellum.assistant;

import ai.vellum.assistant.push.NativePushRenderer;
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

    /**
     * Whether the web runtime currently holds a handler for foreground pushes.
     * The plugin instance outlives that handler, so the renderer asks this
     * instead: a push handed to a torn-down handler is simply lost.
     */
    private static volatile boolean foregroundHandler;

    @PluginMethod
    public void register(PluginCall call) {
        invokeSafely(call, plugin -> plugin.register(call));
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        invokeSafely(call, plugin -> {
            plugin.unregister(call);
            // The conversation shortcuts carry the previous account's titles
            // and avatars, so they leave with its token, and only once the
            // token is actually on its way out.
            NativeFailureGuard.run(
                "Unable to remove the Android conversation shortcuts",
                () -> NativePushRenderer.clearConversationShortcuts(getContext())
            );
        });
    }

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        call.resolve(capabilitiesPayload());
    }

    @PluginMethod
    public void setForegroundHandler(PluginCall call) {
        setForegroundHandler(Boolean.TRUE.equals(call.getBoolean("active", false)));
        call.resolve();
    }

    static void setForegroundHandler(boolean active) {
        foregroundHandler = active;
    }

    public static boolean hasForegroundHandler() {
        return foregroundHandler;
    }

    /** A page load takes the handler with it without running its own teardown. */
    public static void clearForegroundHandler() {
        foregroundHandler = false;
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
