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
    public static final int DELIVERY_KEY_MAX_CHARACTERS = 512;

    private static final String DEFAULT_SOURCE_EVENT_NAME = "remote_push";
    private static final String DEFAULT_TITLE = "Vellum";
    private static final String LOCAL_MESSAGE_ID_PREFIX = "vellum-local:";

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
    @Nullable
    private final String deliveryKey;
    private final boolean hasInvalidDeliveryKeyCandidate;
    private final boolean hasNotificationBlock;

    private PushDataMessage(
        Map<String, String> data,
        boolean hasNotificationBlock,
        @Nullable String messageId,
        @Nullable String deliveryKey
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
        String dataDeliveryId = data.get(KEY_DELIVERY_ID);
        deliveryId = canonicalDeliveryPart(dataDeliveryId);
        this.deliveryKey = canonicalDeliveryPart(deliveryKey);
        hasInvalidDeliveryKeyCandidate = isInvalidDeliveryPart(dataDeliveryId)
            || isInvalidDeliveryPart(deliveryKey);
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

    /**
     * Builds the same parsed data shape for an app-local request. The stable
     * request key is generated once by the caller and retained across retries.
     */
    public static PushDataMessage fromLocalData(
        @Nullable Map<String, String> data,
        @Nullable String correlationId,
        @Nullable String deliveryId,
        @Nullable String stableRequestKey
    ) {
        Map<String, String> resolvedData = data == null ? Collections.emptyMap() : data;
        String resolvedDeliveryId = firstSemanticallyPresent(
            deliveryId,
            resolvedData.get(KEY_DELIVERY_ID)
        );
        String resolvedDeliveryKey = deliveryKey(
            correlationId,
            resolvedDeliveryId,
            stableRequestKey
        );
        if (resolvedDeliveryKey == null) {
            throw new IllegalArgumentException("A local notification needs a stable request key");
        }
        return new PushDataMessage(
            resolvedData,
            false,
            tapMessageId(correlationId, resolvedDeliveryId, stableRequestKey),
            resolvedDeliveryKey
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
            messageId,
            null
        );
    }

    /** Full process-local key shared by the local and FCM delivery routes. */
    @Nullable
    public String deliveryKey() {
        return deliveryKey == null ? deliveryId : deliveryKey;
    }

    /** True when a selected delivery-key candidate exceeded the shared bound. */
    public boolean hasInvalidDeliveryKeyCandidate() {
        return hasInvalidDeliveryKeyCandidate;
    }

    /** Message id carried into Capacitor's push-tap callback. */
    @Nullable
    public String tapMessageId() {
        return messageId;
    }

    /** True when Firebase rendered nothing and this process owns the notification. */
    public boolean isDataOnly() {
        return !hasNotificationBlock && title != null;
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
     * Selects the full canonical key without hashing it down to an Android
     * notification id. Inputs are already resolved by the caller.
     */
    @Nullable
    public static String deliveryKey(
        @Nullable String correlationId,
        @Nullable String deliveryId,
        @Nullable String stableRequestKey
    ) {
        String[] candidates = { correlationId, deliveryId, stableRequestKey };
        for (String candidate : candidates) {
            String key = trimmedDeliveryPart(candidate);
            if (key == null) {
                continue;
            }
            if (key.length() > DELIVERY_KEY_MAX_CHARACTERS) {
                return null;
            }
            return key;
        }
        return null;
    }

    /**
     * Gives a local request a push-compatible tap id. Existing delivery keys
     * keep their current value; only an id-less request receives the prefix.
     */
    @Nullable
    public static String tapMessageId(
        @Nullable String correlationId,
        @Nullable String deliveryId,
        @Nullable String stableRequestKey
    ) {
        String existingId = deliveryKey(correlationId, deliveryId, null);
        if (existingId != null) {
            return existingId;
        }
        String request = canonicalDeliveryPart(stableRequestKey);
        return request == null ? null : LOCAL_MESSAGE_ID_PREFIX + request;
    }

    /**
     * Applies JavaScript {@code String.trim()} whitespace semantics and the
     * shared UTF-16 code-unit bound used by both Android delivery routes.
     */
    @Nullable
    public static String canonicalDeliveryPart(@Nullable String value) {
        String canonical = trimmedDeliveryPart(value);
        return canonical == null || canonical.length() > DELIVERY_KEY_MAX_CHARACTERS
            ? null
            : canonical;
    }

    /** Preserves message-id presence while producing the FCM coordinator rung. */
    @Nullable
    public static String fcmMessageDeliveryKeyCandidate(@Nullable String messageId) {
        String canonical = trimmedDeliveryPart(messageId);
        return canonical == null ? null : "fcm-message:" + canonical;
    }

    @Nullable
    private static String trimmedDeliveryPart(@Nullable String value) {
        if (value == null) {
            return null;
        }
        int start = 0;
        int end = value.length();
        while (start < end) {
            int point = value.codePointAt(start);
            if (!isJavaScriptWhitespace(point)) {
                break;
            }
            start += Character.charCount(point);
        }
        while (end > start) {
            int point = value.codePointBefore(end);
            if (!isJavaScriptWhitespace(point)) {
                break;
            }
            end -= Character.charCount(point);
        }
        String canonical = value.substring(start, end);
        return canonical.isEmpty() ? null : canonical;
    }

    private static boolean isInvalidDeliveryPart(@Nullable String value) {
        String canonical = trimmedDeliveryPart(value);
        return canonical != null && canonical.length() > DELIVERY_KEY_MAX_CHARACTERS;
    }

    @Nullable
    private static String firstSemanticallyPresent(
        @Nullable String preferred,
        @Nullable String fallback
    ) {
        return trimmedDeliveryPart(preferred) == null ? fallback : preferred;
    }

    private static boolean isJavaScriptWhitespace(int point) {
        return point >= 0x0009 && point <= 0x000D
            || point == 0x0020
            || point == 0x00A0
            || point == 0x1680
            || point >= 0x2000 && point <= 0x200A
            || point == 0x2028
            || point == 0x2029
            || point == 0x202F
            || point == 0x205F
            || point == 0x3000
            || point == 0xFEFF;
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
        if (deliveryKey != null) {
            return deliveryKey;
        }
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
