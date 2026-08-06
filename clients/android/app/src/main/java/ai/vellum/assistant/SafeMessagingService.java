package ai.vellum.assistant;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public class SafeMessagingService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        NativeFailureGuard.initialize(this);
        NativeFailureGuard.run(
            "Unable to receive the Android push notification",
            () -> {
                super.onMessageReceived(remoteMessage);
                PushNotificationsPlugin.sendRemoteMessage(remoteMessage);
            }
        );
    }

    @Override
    public void onNewToken(@NonNull String token) {
        NativeFailureGuard.initialize(this);
        NativeFailureGuard.run("Unable to receive the Android push token", () -> {
            super.onNewToken(token);
            PushNotificationsPlugin.onNewToken(token);
        });
    }
}
