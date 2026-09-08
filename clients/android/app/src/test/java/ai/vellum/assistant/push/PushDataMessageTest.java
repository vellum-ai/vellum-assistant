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

    @Test
    public void readsTheAlertFieldsFromTheDataBlock() {
        PushDataMessage message = PushDataMessage.of(alertData(), false);

        assertEquals("Weekly review", message.title);
        assertEquals("Ready when you are.", message.body);
        assertEquals("vellum-alerts", message.channelId);
        assertEquals("delivery-1", message.deliveryId);
        assertEquals("conversation-1", message.conversationId);
        assertEquals(Integer.valueOf(3), message.unreadCount);
        assertNull(message.sender);
    }

    @Test
    public void readsTheSenderWhenIdNameAndHashAreAllPresent() {
        PushDataMessage.Sender sender = PushDataMessage.of(senderData(), false).sender;

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

        PushDataMessage.Sender sender = PushDataMessage.of(data, false).sender;

        assertNotNull(sender);
        assertNull(sender.avatarUrl);
    }

    @Test
    public void dropsThePartialSender() {
        for (String key : new String[] { "sender_id", "sender_name", "sender_avatar_hash" }) {
            Map<String, String> data = senderData();
            data.put(key, "  ");
            assertNull(key, PushDataMessage.of(data, false).sender);
        }
    }

    @Test
    public void fallsBackToTheAlertsChannelAndSkipsUnparsableCounts() {
        Map<String, String> data = alertData();
        data.remove("channel_id");
        data.put("unread_count", "many");

        PushDataMessage message = PushDataMessage.of(data, false);

        assertEquals("vellum-alerts", message.channelId);
        assertNull(message.unreadCount);
    }

    @Test
    public void onlyATitledPayloadWithoutANotificationBlockIsDataOnly() {
        assertTrue(PushDataMessage.of(alertData(), false).isDataOnly());
        assertFalse(PushDataMessage.of(alertData(), true).isDataOnly());

        Map<String, String> untitled = alertData();
        untitled.remove("title");
        assertFalse(PushDataMessage.of(untitled, false).isDataOnly());
        assertFalse(PushDataMessage.of(null, false).isDataOnly());
    }

    @Test
    public void onlyABackgroundedDataOnlyPushIsRenderedNatively() {
        assertTrue(PushDataMessage.of(alertData(), false).rendersNatively(false));
        assertFalse("foreground", PushDataMessage.of(alertData(), false).rendersNatively(true));
        assertFalse(
            "notification block",
            PushDataMessage.of(alertData(), true).rendersNatively(false)
        );

        Map<String, String> untitled = alertData();
        untitled.remove("title");
        assertFalse("untitled", PushDataMessage.of(untitled, false).rendersNatively(false));
    }

    @Test
    public void theShortcutIdSeparatesTwoConversationsWithOneAssistant() {
        assertEquals(
            "assistant-1:conversation-1",
            PushDataMessage.shortcutId("assistant-1", "conversation-1")
        );
        assertNotEquals(
            PushDataMessage.shortcutId("assistant-1", "conversation-1"),
            PushDataMessage.shortcutId("assistant-1", "conversation-2")
        );
    }

    @Test
    public void theShortcutIdFallsBackToTheAssistantWithoutAConversation() {
        Map<String, String> data = alertData();
        data.remove("conversationId");

        PushDataMessage message = PushDataMessage.of(data, false);

        assertNull(message.conversationId);
        assertEquals(
            "assistant-1",
            PushDataMessage.shortcutId("assistant-1", message.conversationId)
        );
    }

    @Test
    public void theNotificationIdIsStablePerDelivery() {
        int first = PushDataMessage.of(alertData(), false).notificationId();
        Map<String, String> other = alertData();
        other.put("delivery_id", "delivery-2");

        assertEquals(first, PushDataMessage.of(alertData(), false).notificationId());
        assertNotEquals(first, PushDataMessage.of(other, false).notificationId());
    }
}
