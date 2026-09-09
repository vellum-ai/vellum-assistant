package ai.vellum.assistant;

import ai.vellum.assistant.push.AvatarCache;
import ai.vellum.assistant.push.NativePushRenderer;
import ai.vellum.assistant.push.PushDataMessage;
import android.graphics.Bitmap;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Routes each push to exactly one renderer. A data-only push this process owns
 * gets the conversation treatment with the sender's avatar; everything else,
 * including a data-only push the web layer will render while the app is on
 * screen, goes to the Capacitor plugin and shows without an avatar.
 */
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
                if (message.rendersNatively(webWillRender()) && render(remoteMessage, message)) {
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
     * thread inside onMessageReceived under {@link AvatarCache}'s own total
     * deadline, and only once the renderer says a notification can be posted at
     * all.
     *
     * @return false only when this path threw, leaving the push for the web
     *     layer rather than dropping it.
     */
    private boolean render(RemoteMessage remoteMessage, PushDataMessage message) {
        return NativeFailureGuard.getAllocating(
            "Unable to render the Android push notification",
            () -> {
                if (NativePushRenderer.canPost(this)) {
                    AvatarCache cache = new AvatarCache(this);
                    NativePushRenderer.show(this, remoteMessage, message, avatar(message, cache));
                }
                return true;
            },
            false
        );
    }

    /** Runs on the Firebase message thread, so the cache read and fetch may block. */
    @Nullable
    private Bitmap avatar(PushDataMessage message, AvatarCache cache) {
        PushDataMessage.Sender sender = message.sender;
        if (sender == null) {
            return null;
        }
        return NativeFailureGuard.getAllocating(
            "Unable to load the Android push notification avatar",
            () -> {
                Bitmap cached = cache.load(sender.avatarHash);
                return cached == null ? cache.fetch(sender.avatarUrl, sender.avatarHash) : cached;
            },
            null
        );
    }

    /**
     * The web layer renders only a push it can actually receive, which takes an
     * activity in front of the user and a foreground handler the web runtime
     * asserts for as long as it is registered. A push arriving during a cold
     * start, on a route that has torn the handler down, or while only the Quick
     * Settings tile holds the process up, is rendered natively instead of lost.
     */
    private boolean webWillRender() {
        return MainActivity.isResumed() && AndroidPushRegistrationPlugin.hasForegroundHandler();
    }
}
