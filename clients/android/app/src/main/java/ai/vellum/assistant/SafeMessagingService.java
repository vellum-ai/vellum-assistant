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
import java.util.function.Function;

public class SafeMessagingService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        NativeFailureGuard.initialize(this);
        NativeFailureGuard.run(
            "Unable to receive the Android push notification",
            () -> {
                super.onMessageReceived(remoteMessage);
                PushDataMessage message = PushDataMessage.from(remoteMessage);
                // Exactly one of the two renderers runs. Handing a natively
                // rendered push to the plugin as well would either fire
                // pushNotificationReceived at a live bridge or stash the
                // message for replay on the next load, and the web handler
                // posts its own banner from either.
                if (message.rendersNatively(isAppForeground())) {
                    render(remoteMessage, message);
                    return;
                }
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

    /**
     * Posts with whatever the cache already holds, then re-posts the same
     * notification id once a download lands. onMessageReceived runs in a short
     * execution window, so nothing waits on the network before the first post.
     */
    private void render(RemoteMessage remoteMessage, PushDataMessage message) {
        AvatarCache cache = new AvatarCache(this);
        Bitmap cached = avatar(message, sender -> cache.load(sender.avatarHash));
        NativePushRenderer.show(this, remoteMessage, message, cached);
        if (cached != null) {
            return;
        }
        Bitmap fetched = avatar(message, sender ->
            cache.fetch(sender.avatarUrl, sender.avatarHash)
        );
        if (fetched != null) {
            NativePushRenderer.show(this, remoteMessage, message, fetched);
        }
    }

    /** Runs on the Firebase message thread, so the cache read and fetch may block. */
    @Nullable
    private Bitmap avatar(
        PushDataMessage message,
        Function<PushDataMessage.Sender, Bitmap> load
    ) {
        PushDataMessage.Sender sender = message.sender;
        if (sender == null) {
            return null;
        }
        return NativeFailureGuard.get(
            "Unable to load the Android push notification avatar",
            () -> load.apply(sender),
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
