package ai.vellum.assistant;

import ai.vellum.assistant.push.AvatarCache;
import ai.vellum.assistant.push.NativePushRenderer;
import ai.vellum.assistant.push.PushDataMessage;
import android.app.ActivityManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.os.Process;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.List;

public class SafeMessagingService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        NativeFailureGuard.initialize(this);
        NativeFailureGuard.run(
            "Unable to receive the Android push notification",
            () -> {
                super.onMessageReceived(remoteMessage);
                PushNotificationsPlugin.sendRemoteMessage(remoteMessage);
                PushDataMessage message = PushDataMessage.from(remoteMessage);
                // A foreground data-only push stays with the web handler.
                if (message.isDataOnly() && !isAppForeground()) {
                    NativePushRenderer.show(this, remoteMessage, message, avatar(message));
                }
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

    /** Runs on the Firebase message thread, so the cache read and fetch may block. */
    @Nullable
    private Bitmap avatar(PushDataMessage message) {
        PushDataMessage.Sender sender = message.sender;
        if (sender == null) {
            return null;
        }
        return NativeFailureGuard.get(
            "Unable to load the Android push notification avatar",
            () -> {
                AvatarCache cache = new AvatarCache(this);
                Bitmap cached = cache.load(sender.avatarHash);
                return cached == null ? cache.fetch(sender.avatarUrl, sender.avatarHash) : cached;
            },
            null
        );
    }

    private boolean isAppForeground() {
        ActivityManager manager = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
        if (manager == null) {
            return false;
        }
        List<ActivityManager.RunningAppProcessInfo> processes = manager.getRunningAppProcesses();
        if (processes == null) {
            return false;
        }
        int pid = Process.myPid();
        for (ActivityManager.RunningAppProcessInfo process : processes) {
            if (process.pid == pid) {
                return process.importance
                    == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
            }
        }
        return false;
    }
}
