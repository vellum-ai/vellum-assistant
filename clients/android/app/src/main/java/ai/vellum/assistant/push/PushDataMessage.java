package ai.vellum.assistant.push;

import ai.vellum.assistant.AndroidNotificationChannelsPlugin;
import androidx.annotation.Nullable;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Collections;
import java.util.Map;

/** The Vellum fields of a push, read from the FCM {@code data} block. */
public final class PushDataMessage {
    /** Marks the shortcuts this renderer owns so pruning leaves the launcher's alone. */
    static final String SHORTCUT_ID_PREFIX = "vellum-conversation:";

    private static final String DEFAULT_SOURCE_EVENT_NAME = "remote_push";
    private static final String DEFAULT_TITLE = "Vellum";

    private static final String KEY_TITLE = "title";
    private static final String KEY_BODY = "body";
    private static final String KEY_CHANNEL_ID = "channel_id";
    private static final String KEY_SOURCE_EVENT_NAME = "source_event_name";
    static final String KEY_DELIVERY_ID = "delivery_id";
    static final String KEY_CONVERSATION_ID = "conversationId";
    private static final String KEY_UNREAD_COUNT = "unread_count";
    private static final String KEY_SENDER_ID = "sender_id";
    private static final String KEY_SENDER_NAME = "sender_name";
    private static final String KEY_SENDER_AVATAR_URL = "sender_avatar_url";
    private static final String KEY_SENDER_AVATAR_HASH = "sender_avatar_hash";

    /** The assistant a conversation notification is attributed to. */
    public static final class Sender {
        public final String id;
        public final String name;
        @Nullable
        public final String avatarUrl;
        public final String avatarHash;

        private Sender(String id, String name, @Nullable String avatarUrl, String avatarHash) {
            this.id = id;
            this.name = name;
            this.avatarUrl = avatarUrl;
            this.avatarHash = avatarHash;
        }
    }

    /** Never null on a natively rendered push: {@link #isDataOnly} requires it. */
    @Nullable
    public final String title;
    @Nullable
    public final String body;
    public final String channelId;
    @Nullable
    public final String conversationId;
    @Nullable
    public final Integer unreadCount;
    @Nullable
    public final Sender sender;

    @Nullable
    private final String deliveryId;
    private final String sourceEventName;
    @Nullable
    private final String messageId;
    private final boolean hasNotificationBlock;

    private PushDataMessage(
        Map<String, String> data,
        boolean hasNotificationBlock,
        @Nullable String messageId
    ) {
        this.hasNotificationBlock = hasNotificationBlock;
        this.messageId = trimmed(messageId);
        title = trimmed(data.get(KEY_TITLE));
        body = trimmed(data.get(KEY_BODY));
        String channel = trimmed(data.get(KEY_CHANNEL_ID));
        channelId = channel == null
            ? AndroidNotificationChannelsPlugin.ALERTS_CHANNEL_ID
            : channel;
        String source = trimmed(data.get(KEY_SOURCE_EVENT_NAME));
        sourceEventName = source == null ? DEFAULT_SOURCE_EVENT_NAME : source;
        deliveryId = trimmed(data.get(KEY_DELIVERY_ID));
        conversationId = trimmed(data.get(KEY_CONVERSATION_ID));
        unreadCount = count(data.get(KEY_UNREAD_COUNT));
        sender = sender(data);
    }

    public static PushDataMessage from(RemoteMessage remoteMessage) {
        return of(
            remoteMessage.getData(),
            remoteMessage.getNotification() != null,
            remoteMessage.getMessageId()
        );
    }

    static PushDataMessage of(
        @Nullable Map<String, String> data,
        boolean hasNotificationBlock,
        @Nullable String messageId
    ) {
        return new PushDataMessage(
            data == null ? Collections.emptyMap() : data,
            hasNotificationBlock,
            messageId
        );
    }

    /** True when Firebase rendered nothing and this process owns the notification. */
    public boolean isDataOnly() {
        return !hasNotificationBlock && title != null;
    }

    /**
     * True when this process posts the notification itself. The web layer owns
     * every other push, and the two paths never both run: a second banner would
     * otherwise land beside or on top of this one. A data-only push the web
     * layer cannot render, because no screen is in front of the user or the
     * bridge is not up yet, still belongs here.
     */
    public boolean rendersNatively(boolean webWillRender) {
        return isDataOnly() && !webWillRender;
    }

    /**
     * Shortcut identity for the conversation. Two threads with one assistant
     * share a sender id, so the conversation id keeps their shortcuts, ranking,
     * and per-conversation settings apart.
     */
    static String shortcutId(String senderId, String conversationId) {
        return SHORTCUT_ID_PREFIX + senderId + ":" + conversationId;
    }

    /** Stable per-delivery id so a redelivery replaces its own notification. */
    public int notificationId() {
        return notificationId(seed());
    }

    /**
     * The same id the web layer derives in {@code toNotificationId}
     * (clients/web/src/runtime/notifications.ts), so a delivery rendered by
     * both paths lands on one notification rather than two.
     * {@code String.hashCode} is JavaScript's {@code (hash << 5) - hash +
     * charCode | 0} loop, and the widening to {@code long} keeps
     * {@code Integer.MIN_VALUE} positive the way {@code Math.abs} does there.
     */
    static int notificationId(String seed) {
        return (int) (Math.abs((long) seed.hashCode()) % 0x7fffffffL);
    }

    /**
     * The seed chain {@code postForegroundRemotePush} walks: the delivery id,
     * then the Firebase message id it reads as {@code notification.id}, then
     * the source event with the copy. Hashing nothing would collapse unrelated
     * deliveries onto a single notification id. Every rung is trimmed on both
     * sides, so padded copy hashes to the same id here and there.
     */
    private String seed() {
        if (deliveryId != null) {
            return deliveryId;
        }
        if (messageId != null) {
            return messageId;
        }
        return sourceEventName
            + ":"
            + (title == null ? DEFAULT_TITLE : title)
            + ":"
            + (body == null ? "" : body);
    }

    @Nullable
    private static Sender sender(Map<String, String> data) {
        String id = trimmed(data.get(KEY_SENDER_ID));
        String name = trimmed(data.get(KEY_SENDER_NAME));
        String avatarHash = trimmed(data.get(KEY_SENDER_AVATAR_HASH));
        if (id == null || name == null || avatarHash == null) {
            return null;
        }
        return new Sender(id, name, trimmed(data.get(KEY_SENDER_AVATAR_URL)), avatarHash);
    }

    @Nullable
    private static Integer count(@Nullable String value) {
        String trimmed = trimmed(value);
        if (trimmed == null) {
            return null;
        }
        try {
            return Integer.valueOf(trimmed);
        } catch (NumberFormatException exception) {
            return null;
        }
    }

    @Nullable
    static String trimmed(@Nullable String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
