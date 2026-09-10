package ai.vellum.assistant.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.Test;

public class PushDataMessageTest {
    private static final String AVATAR_HASH =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    private static Map<String, String> alertData() {
        Map<String, String> data = new LinkedHashMap<>();
        data.put("title", "Weekly review");
        data.put("body", "Ready when you are.");
        data.put("channel_id", "vellum-alerts");
        data.put("delivery_id", "delivery-1");
        data.put("conversationId", "conversation-1");
        data.put("unread_count", "3");
        return data;
    }

    private static Map<String, String> senderData() {
        Map<String, String> data = alertData();
        data.put("sender_id", "assistant-1");
        data.put("sender_name", "Vellum");
        data.put("sender_avatar_url", "https://example.com/avatar.png");
        data.put("sender_avatar_hash", AVATAR_HASH);
        return data;
    }

    private static PushDataMessage message(Map<String, String> data) {
        return PushDataMessage.of(data, false, null);
    }

    @Test
    public void readsTheAlertFieldsFromTheDataBlock() {
        PushDataMessage message = message(alertData());

        assertEquals("Weekly review", message.title);
        assertEquals("Ready when you are.", message.body);
        assertEquals("vellum-alerts", message.channelId);
        assertEquals("conversation-1", message.conversationId);
        assertEquals(Integer.valueOf(3), message.unreadCount);
        assertNull(message.sender);
    }

    @Test
    public void readsTheSenderWhenIdNameAndHashAreAllPresent() {
        PushDataMessage.Sender sender = message(senderData()).sender;

        assertNotNull(sender);
        assertEquals("assistant-1", sender.id);
        assertEquals("Vellum", sender.name);
        assertEquals("https://example.com/avatar.png", sender.avatarUrl);
        assertEquals(AVATAR_HASH, sender.avatarHash);
    }

    /** The platform drops the signed url first when the payload is oversized. */
    @Test
    public void keepsTheSenderWhenOnlyTheAvatarUrlIsMissing() {
        Map<String, String> data = senderData();
        data.remove("sender_avatar_url");

        PushDataMessage.Sender sender = message(data).sender;

        assertNotNull(sender);
        assertNull(sender.avatarUrl);
    }

    @Test
    public void dropsThePartialSender() {
        for (String key : new String[] { "sender_id", "sender_name", "sender_avatar_hash" }) {
            Map<String, String> data = senderData();
            data.put(key, "  ");
            assertNull(key, message(data).sender);
        }
    }

    @Test
    public void fallsBackToTheAlertsChannelAndSkipsUnparsableCounts() {
        Map<String, String> data = alertData();
        data.remove("channel_id");
        data.put("unread_count", "many");

        PushDataMessage message = message(data);

        assertEquals("vellum-alerts", message.channelId);
        assertNull(message.unreadCount);
    }

    @Test
    public void onlyATitledPayloadWithoutANotificationBlockIsDataOnly() {
        assertTrue(message(alertData()).isDataOnly());
        assertFalse(PushDataMessage.of(alertData(), true, null).isDataOnly());

        Map<String, String> untitled = alertData();
        untitled.remove("title");
        assertFalse(message(untitled).isDataOnly());
        assertFalse(message(null).isDataOnly());
    }

    @Test
    public void onlyADataOnlyPushTheWebLayerCannotRenderIsRenderedNatively() {
        assertTrue(message(alertData()).rendersNatively(false));
        assertFalse("web layer renders it", message(alertData()).rendersNatively(true));
        assertFalse(
            "notification block",
            PushDataMessage.of(alertData(), true, null).rendersNatively(false)
        );

        Map<String, String> untitled = alertData();
        untitled.remove("title");
        assertFalse("untitled", message(untitled).rendersNatively(false));
    }

    @Test
    public void theShortcutIdSeparatesTwoConversationsWithOneAssistant() {
        assertEquals(
            "vellum-conversation:assistant-1:conversation-1",
            PushDataMessage.shortcutId("assistant-1", "conversation-1")
        );
        assertNotEquals(
            PushDataMessage.shortcutId("assistant-1", "conversation-1"),
            PushDataMessage.shortcutId("assistant-1", "conversation-2")
        );
    }

    /** Pruning has to tell our conversation shortcuts from the launcher's own. */
    @Test
    public void everyShortcutIdCarriesTheOwnershipPrefix() {
        assertTrue(
            PushDataMessage.shortcutId("assistant-1", "conversation-1")
                .startsWith(PushDataMessage.SHORTCUT_ID_PREFIX)
        );
    }

    @Test
    public void theNotificationIdIsStablePerDelivery() {
        int first = message(alertData()).notificationId();
        Map<String, String> other = alertData();
        other.put("delivery_id", "delivery-2");

        assertEquals(first, message(alertData()).notificationId());
        assertNotEquals(first, message(other).notificationId());
    }

    /**
     * The expected values come from running the web layer's toNotificationId
     * (clients/web/src/runtime/notifications.ts) over the same seeds. A drift
     * here shows both a native and a web notification for one delivery.
     */
    @Test
    public void theNotificationIdMatchesTheWebFormula() {
        assertEquals(1077802136, PushDataMessage.notificationId("delivery-1"));
        assertEquals("negative hash", 1676096153, PushDataMessage.notificationId("conversation-1"));
        assertEquals("Integer.MIN_VALUE", 1, PushDataMessage.notificationId("delivery-4b*42%$"));
        assertEquals(1440014357, PushDataMessage.notificationId("message-1"));
        assertEquals(
            126856326,
            PushDataMessage.notificationId("remote_push:Weekly review:Ready when you are.")
        );
    }

    /**
     * postForegroundRemotePush seeds toNotificationId with the delivery id,
     * then the Firebase message id it reads as notification.id, then the source
     * event with the copy. The conversation id is not a rung of that chain.
     */
    @Test
    public void theNotificationIdSeedWalksTheSameChainAsTheWebLayer() {
        assertEquals(
            PushDataMessage.notificationId("delivery-1"),
            PushDataMessage.of(alertData(), false, "message-1").notificationId()
        );

        Map<String, String> data = alertData();
        data.remove("delivery_id");
        assertEquals(
            PushDataMessage.notificationId("message-1"),
            PushDataMessage.of(data, false, "message-1").notificationId()
        );
        assertNotEquals(
            "the conversation id is not a seed",
            PushDataMessage.notificationId("conversation-1"),
            PushDataMessage.of(data, false, "message-1").notificationId()
        );

        assertEquals(
            PushDataMessage.notificationId("remote_push:Weekly review:Ready when you are."),
            message(data).notificationId()
        );

        data.put("source_event_name", "chat.assistant_turn_complete");
        assertEquals(
            PushDataMessage.notificationId(
                "chat.assistant_turn_complete:Weekly review:Ready when you are."
            ),
            message(data).notificationId()
        );
    }

    /**
     * Both sides trim every rung before hashing, so padding in the payload
     * cannot split one delivery across a native and a web notification.
     */
    @Test
    public void theFallbackSeedIgnoresPaddingTheWayTheWebLayerDoes() {
        Map<String, String> padded = alertData();
        padded.remove("delivery_id");
        padded.put("title", "  Weekly review  ");
        padded.put("body", "\tReady when you are.\n");
        padded.put("source_event_name", " remote_push ");

        assertEquals(
            126856326,
            PushDataMessage.of(padded, false, "   ").notificationId()
        );
    }
}
