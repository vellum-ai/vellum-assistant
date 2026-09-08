package ai.vellum.assistant.push;

import androidx.annotation.Nullable;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Collections;
import java.util.Map;
import java.util.Objects;

/** The Vellum fields of a push, read from the FCM {@code data} block. */
public final class PushDataMessage {
    static final String DEFAULT_CHANNEL_ID = "vellum-alerts";

    private static final String KEY_TITLE = "title";
    private static final String KEY_BODY = "body";
    private static final String KEY_CHANNEL_ID = "channel_id";
    static final String KEY_DELIVERY_ID = "delivery_id";
    private static final String KEY_CONVERSATION_ID = "conversationId";
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

    private final boolean hasNotificationBlock;

    private PushDataMessage(Map<String, String> data, boolean hasNotificationBlock) {
        this.hasNotificationBlock = hasNotificationBlock;
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
        return of(remoteMessage.getData(), remoteMessage.getNotification() != null);
    }

    static PushDataMessage of(@Nullable Map<String, String> data, boolean hasNotificationBlock) {
        return new PushDataMessage(
            data == null ? Collections.emptyMap() : data,
            hasNotificationBlock
        );
    }

    /** True when Firebase rendered nothing and this process owns the notification. */
    public boolean isDataOnly() {
        return !hasNotificationBlock && title != null;
    }

    /**
     * True when this process posts the notification itself. The web layer owns
     * every other push, and the two paths never both run: a second banner would
     * otherwise land beside or on top of this one.
     */
    public boolean rendersNatively(boolean appIsForeground) {
        return isDataOnly() && !appIsForeground;
    }

    /**
     * Shortcut identity for the conversation. Two threads with one assistant
     * share a sender id, so the conversation id keeps their shortcuts, ranking,
     * and per-conversation settings apart.
     */
    static String shortcutId(String senderId, @Nullable String conversationId) {
        return conversationId == null ? senderId : senderId + ":" + conversationId;
    }

    /** Stable per-delivery id so a redelivery replaces its own notification. */
    public int notificationId() {
        return Objects.hashCode(deliveryId == null ? conversationId : deliveryId);
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
