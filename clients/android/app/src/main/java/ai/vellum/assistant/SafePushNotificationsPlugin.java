package ai.vellum.assistant;

import android.Manifest;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.messaging.RemoteMessage;

@CapacitorPlugin(
    name = "PushNotifications",
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "receive")
)
public class SafePushNotificationsPlugin extends PushNotificationsPlugin {
    @Override
    public void load() {
        NativeFailureGuard.initialize(getContext());
        NativeFailureGuard.run("Unable to load Android push notifications", () -> super.load());
    }

    @Override
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        guard(call, () -> super.checkPermissions(call));
    }

    @Override
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        guard(call, () -> super.requestPermissions(call));
    }

    @Override
    @PluginMethod
    public void register(PluginCall call) {
        guard(call, () -> {
            FirebaseMessaging messaging = FirebaseMessaging.getInstance();
            messaging.setAutoInitEnabled(true);
            messaging.getToken().addOnCompleteListener(task -> {
                NativeFailureGuard.run("Unable to finish Android push registration", () -> {
                    if (!task.isSuccessful()) {
                        Exception exception = task.getException();
                        sendError(
                            exception == null || exception.getLocalizedMessage() == null
                                ? PushRegistrationGuard.FAILURE_MESSAGE
                                : exception.getLocalizedMessage()
                        );
                        return;
                    }
                    String token = task.getResult();
                    if (token == null) {
                        sendError(PushRegistrationGuard.FAILURE_MESSAGE);
                        return;
                    }
                    sendToken(token);
                });
            });
            call.resolve();
        });
    }

    @Override
    @PluginMethod
    public void unregister(PluginCall call) {
        guard(call, () -> super.unregister(call));
    }

    @Override
    public void sendToken(String token) {
        NativeFailureGuard.run("Unable to deliver the Android push token", () -> super.sendToken(token));
    }

    @Override
    public void sendError(String error) {
        NativeFailureGuard.run("Unable to deliver the Android push error", () -> super.sendError(error));
    }

    @Override
    public void fireNotification(RemoteMessage remoteMessage) {
        NativeFailureGuard.run(
            "Unable to process the Android push notification",
            () -> super.fireNotification(remoteMessage)
        );
    }

    private void guard(PluginCall call, Runnable operation) {
        PushRegistrationGuard.call(call, operation);
    }
}
