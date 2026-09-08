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
                PushDataMessage message = PushDataMessage.from(remoteMessage);
                // Exactly one of the two renderers runs. Handing a natively
                // rendered push to the plugin as well would either fire
                // pushNotificationReceived at a live bridge or stash the
                // message for replay on the next load, and the web handler
                // posts its own banner from either.
                if (message.rendersNatively(webWillRender())) {
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
     * Resolves the avatar before posting rather than posting twice: a second
     * post on the same id flickers the banner and can land after the user has
     * already dismissed the first. The download runs on the Firebase message
     * thread inside onMessageReceived, so {@link AvatarCache}'s timeouts are
     * the whole budget it gets.
     */
    private void render(RemoteMessage remoteMessage, PushDataMessage message) {
        AvatarCache cache = new AvatarCache(this);
        NativePushRenderer.show(this, remoteMessage, message, avatar(message, cache));
    }

    /** Runs on the Firebase message thread, so the cache read and fetch may block. */
    @Nullable
    private Bitmap avatar(PushDataMessage message, AvatarCache cache) {
        PushDataMessage.Sender sender = message.sender;
        if (sender == null) {
            return null;
        }
        return NativeFailureGuard.get(
            "Unable to load the Android push notification avatar",
            () -> {
                Bitmap cached = cache.load(sender.avatarHash);
                return cached == null ? cache.fetch(sender.avatarUrl, sender.avatarHash) : cached;
            },
            null
        );
    }

    /**
     * The web layer renders only a push it can actually receive, which takes a
     * screen in front of the user and a bridge that is already up. A push
     * arriving during a cold start, or while the app sits on a route that has
     * not registered the handler, is rendered natively instead of lost.
     */
    private boolean webWillRender() {
        return isOnScreen() && PushNotificationsPlugin.getPushNotificationsInstance() != null;
    }

    private boolean isOnScreen() {
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
            if (process.pid != pid) {
                continue;
            }
            // A partly covered activity still shows the web layer's own banner.
            return process.importance
                == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
                || process.importance
                    == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE;
        }
        return false;
    }
}
