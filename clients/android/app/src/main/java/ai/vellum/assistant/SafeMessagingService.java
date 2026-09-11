package ai.vellum.assistant;

import ai.vellum.assistant.push.AvatarCache;
import ai.vellum.assistant.push.NativePushRenderer;
import ai.vellum.assistant.push.NotificationDeliveryCoordinator;
import ai.vellum.assistant.push.PushDataMessage;
import android.graphics.Bitmap;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

/**
 * Routes each push to exactly one renderer. A live foreground web handler
 * applies focused-conversation policy, then posts through the process
 * coordinator. Background data-only delivery uses that coordinator directly.
 * Notification-block pushes keep their existing Capacitor behavior.
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
                boolean negotiatedOwnership = AndroidPushRegistrationPlugin
                    .hasNotificationOwnership();
                DeliveryRoute route = deliveryRoute(
                    message.isDataOnly(),
                    webWillRender()
                );
                if (route == DeliveryRoute.NATIVE_COORDINATOR) {
                    NotificationDeliveryCoordinator.DeliveryResult result = render(
                        remoteMessage,
                        message
                    );
                    if (nativeOwnsResult(result, negotiatedOwnership)) {
                        return;
                    }
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
     * @return the coordinator's terminal ownership result.
     */
    private NotificationDeliveryCoordinator.DeliveryResult render(
        RemoteMessage remoteMessage,
        PushDataMessage message
    ) {
        final String initialBlockReason;
        final String key;
        final int notificationId;
        try {
            key = deliveryKey(remoteMessage, message);
            notificationId = message.notificationId();
        } catch (Throwable throwable) {
            NativeFailureGuard.record(
                "Unable to identify the Android push notification",
                throwable
            );
            return deliveryFailure(false, throwable);
        }
        if (key == null) {
            return NotificationDeliveryCoordinator.DeliveryResult.failed(
                false,
                "missing_delivery_key"
            );
        }
        try {
            initialBlockReason = NativePushRenderer.postBlockReason(
                this,
                message.channelId
            );
        } catch (Throwable throwable) {
            NativeFailureGuard.record(
                "Unable to check Android push notification delivery",
                throwable
            );
            return deliveryFailure(false, throwable);
        }

        try {
            NotificationDeliveryCoordinator.DeliveryResult result =
                NotificationDeliveryCoordinator.shared().deliver(
                key,
                notificationId,
                () -> NativeFailureGuard.getAllocating(
                    "Unable to prepare the Android push notification avatar",
                    () -> prepareAvatar(
                        initialBlockReason,
                        () -> avatar(message, new AvatarCache(this))
                    ),
                    CompletableFuture.completedFuture(null)
                ),
                (ownedNotificationId, avatar) -> NativeFailureGuard.getAllocating(
                    "Unable to post the Android push notification",
                    () -> {
                        String blockReason = NativePushRenderer.postBlockReason(
                            this,
                            message.channelId
                        );
                        if (blockReason != null) {
                            return NotificationDeliveryCoordinator.DeliveryResult.blocked(
                                blockReason
                            );
                        }
                        NativePushRenderer.show(this, remoteMessage, message, avatar);
                        return NotificationDeliveryCoordinator.DeliveryResult.posted();
                    },
                    NotificationDeliveryCoordinator.DeliveryResult.unknown(
                        true,
                        "Notification post failed",
                        null
                    )
                )
            ).join();
            return claimedResult(result);
        } catch (Throwable throwable) {
            NativeFailureGuard.record(
                "Unable to render the Android push notification",
                throwable
            );
            return deliveryFailure(true, throwable);
        }
    }

    static NotificationDeliveryCoordinator.DeliveryResult deliveryFailure(
        boolean coordinatorInvoked,
        Throwable throwable
    ) {
        return NotificationDeliveryCoordinator.DeliveryResult.unknown(
            coordinatorInvoked,
            "Notification delivery failed",
            throwable.getClass().getSimpleName()
        );
    }

    static NotificationDeliveryCoordinator.DeliveryResult claimedResult(
        NotificationDeliveryCoordinator.DeliveryResult result
    ) {
        if (
            !result.postingMayHaveBegun
                && (
                    result.status == NotificationDeliveryCoordinator.DeliveryStatus.FAILED
                        || result.status
                            == NotificationDeliveryCoordinator.DeliveryStatus.UNKNOWN
                )
        ) {
            return NotificationDeliveryCoordinator.DeliveryResult.unknown(
                true,
                result.reason,
                result.error
            );
        }
        return result;
    }

    static <A> CompletableFuture<A> prepareAvatar(
        @Nullable String blockReason,
        Supplier<A> preparation
    ) {
        return CompletableFuture.completedFuture(
            blockReason == null ? preparation.get() : null
        );
    }

    enum DeliveryRoute {
        NATIVE_COORDINATOR,
        CAPACITOR_PLUGIN,
    }

    static DeliveryRoute deliveryRoute(
        boolean dataOnly,
        boolean webWillRender
    ) {
        if (!dataOnly) {
            return DeliveryRoute.CAPACITOR_PLUGIN;
        }
        return webWillRender
            ? DeliveryRoute.CAPACITOR_PLUGIN
            : DeliveryRoute.NATIVE_COORDINATOR;
    }

    static boolean nativeOwnsResult(
        NotificationDeliveryCoordinator.DeliveryResult result,
        boolean negotiatedOwnership
    ) {
        if (negotiatedOwnership) {
            return true;
        }
        if (
            result.status == NotificationDeliveryCoordinator.DeliveryStatus.FAILED
                || result.status == NotificationDeliveryCoordinator.DeliveryStatus.UNKNOWN
        ) {
            return result.postingMayHaveBegun;
        }
        return result.status != NotificationDeliveryCoordinator.DeliveryStatus.UNAVAILABLE;
    }

    @Nullable
    static String deliveryKey(RemoteMessage remoteMessage, PushDataMessage message) {
        if (message.hasInvalidDeliveryKeyCandidate()) {
            return null;
        }
        return deliveryKey(
            message.deliveryKey(),
            remoteMessage.getMessageId(),
            remoteMessage.getData()
        );
    }

    @Nullable
    static String deliveryKey(
        @Nullable String resolvedDeliveryKey,
        @Nullable String messageIdValue,
        Map<String, String> data
    ) {
        String messageKey = PushDataMessage.fcmMessageDeliveryKeyCandidate(
            messageIdValue
        );
        StringBuilder fallback = new StringBuilder("fcm-data:");
        for (Map.Entry<String, String> entry : new TreeMap<>(data).entrySet()) {
            appendPart(fallback, entry.getKey());
            appendPart(fallback, entry.getValue());
        }
        return PushDataMessage.deliveryKey(
            resolvedDeliveryKey,
            messageKey,
            fallback.toString()
        );
    }

    private static void appendPart(StringBuilder target, @Nullable String value) {
        String part = value == null ? "" : value;
        target.append(part.length()).append(':').append(part);
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
