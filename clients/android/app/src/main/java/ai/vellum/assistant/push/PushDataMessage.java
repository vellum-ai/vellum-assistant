package ai.vellum.assistant.push;

import ai.vellum.assistant.AndroidNotificationChannelsPlugin;
import androidx.annotation.Nullable;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Collections;
import java.util.Map;

/** The Vellum fields of a push, read from the FCM {@code data} block. */
public final class PushDataMessage {
    static final String DEFAULT_CHANNEL_ID = AndroidNotificationChannelsPlugin.ALERTS_CHANNEL_ID;

    /** Marks the shortcuts this renderer owns so pruning leaves the launcher's alone. */
    static final String SHORTCUT_ID_PREFIX = "vellum-conversation:";

    private static final String KEY_TITLE = "title";
    private static final String KEY_BODY = "body";
    private static final String KEY_CHANNEL_ID = "channel_id";
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

    @Nullable
    public final String title;
    @Nullable
    public final String body;
    public final String channelId;
    @Nullable
    public final String deliveryId;
    @Nullable
    public final String conversationId;
    @Nullable
    public final Integer unreadCount;
    @Nullable
    public final Sender sender;

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
        channelId = channel == null ? DEFAULT_CHANNEL_ID : channel;
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

    static PushDataMessage of(@Nullable Map<String, String> data, boolean hasNotificationBlock) {
        return of(data, hasNotificationBlock, null);
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
    static String shortcutId(String senderId, @Nullable String conversationId) {
        String suffix = conversationId == null ? senderId : senderId + ":" + conversationId;
        return SHORTCUT_ID_PREFIX + suffix;
    }

    /** The conversation the shortcut opens, named by its title where there is one. */
    static String shortcutLabel(@Nullable String title, String senderName) {
        String trimmed = trimmed(title);
        return trimmed == null ? senderName : trimmed;
    }

    /** Stable per-delivery id so a redelivery replaces its own notification. */
    public int notificationId() {
        return notificationId(seed());
    }

    /**
     * The same id the web layer derives in {@code toNotificationId}
     * (clients/web/src/runtime/notifications.ts) from the same seed, so a
     * delivery rendered by both paths lands on one notification rather than
     * two. {@code String.hashCode} is JavaScript's {@code (hash << 5) - hash +
     * charCode | 0} loop, and the widening to {@code long} keeps
     * {@code Integer.MIN_VALUE} positive the way {@code Math.abs} does there.
     */
    static int notificationId(String seed) {
        return (int) (Math.abs((long) seed.hashCode()) % 0x7fffffffL);
    }

    /**
     * Every push carries at least one of these. Hashing nothing would collapse
     * unrelated deliveries onto a single notification id.
     */
    private String seed() {
        if (deliveryId != null) {
            return deliveryId;
        }
        if (conversationId != null) {
            return conversationId;
        }
        return messageId == null ? "" : messageId;
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
