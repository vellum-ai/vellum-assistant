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
    static final int NOTIFICATION_OWNERSHIP_VERSION = 1;

    /**
     * Whether the web runtime currently holds a handler for foreground pushes.
     * The plugin instance outlives that handler, so the renderer asks this
     * instead: a push handed to a torn-down handler is simply lost.
     */
    private static volatile boolean foregroundHandler;
    private static volatile boolean notificationOwnership;
    private static int bridgeGeneration;

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

    @PluginMethod
    public void getNotificationOwnershipGeneration(PluginCall call) {
        call.resolve(notificationOwnershipGenerationPayload());
    }

    @PluginMethod
    public void setNotificationOwnership(PluginCall call) {
        Integer version = call.getInt("version");
        Integer generation = call.getInt("generation");
        Boolean active = call.getBoolean("active");
        boolean accepted = negotiateNotificationOwnership(version, generation, active);
        call.resolve(notificationOwnershipPayload(accepted));
    }

    static void setForegroundHandler(boolean active) {
        foregroundHandler = active;
    }

    public static boolean hasForegroundHandler() {
        return foregroundHandler;
    }

    public static boolean hasNotificationOwnership() {
        return notificationOwnership;
    }

    static synchronized boolean negotiateNotificationOwnership(
        Integer version,
        Integer generation,
        Boolean active
    ) {
        if (
            version == null
                || version != NOTIFICATION_OWNERSHIP_VERSION
                || generation == null
                || generation != bridgeGeneration
                || active == null
        ) {
            return false;
        }
        notificationOwnership = active;
        return true;
    }

    static synchronized int bridgeGeneration() {
        return bridgeGeneration;
    }

    public static synchronized void clearBridgeState() {
        foregroundHandler = false;
        notificationOwnership = false;
        bridgeGeneration = bridgeGeneration == Integer.MAX_VALUE
            ? 0
            : bridgeGeneration + 1;
    }

    static void clearBridgeStateSerialized(Consumer<Runnable> bridgeExecutor) {
        clearBridgeState();
        bridgeExecutor.accept(AndroidPushRegistrationPlugin::clearBridgeState);
    }

    static JSObject capabilitiesPayload() {
        JSArray capabilities = new JSArray();
        capabilities.put(NATIVE_NOTIFICATION_RENDER);
        JSObject payload = new JSObject();
        payload.put("capabilities", capabilities);
        return payload;
    }

    static synchronized JSObject notificationOwnershipGenerationPayload() {
        return new JSObject()
            .put("version", NOTIFICATION_OWNERSHIP_VERSION)
            .put("generation", bridgeGeneration);
    }

    static synchronized JSObject notificationOwnershipPayload(boolean accepted) {
        JSObject payload = new JSObject();
        payload.put("version", NOTIFICATION_OWNERSHIP_VERSION);
        payload.put("generation", bridgeGeneration);
        payload.put("active", notificationOwnership);
        payload.put("accepted", accepted);
        return payload;
    }

    @Override
    protected void handleOnDestroy() {
        clearBridgeState();
        super.handleOnDestroy();
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
