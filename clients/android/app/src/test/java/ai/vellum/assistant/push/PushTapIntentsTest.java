package ai.vellum.assistant.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.Test;

public class PushTapIntentsTest {
    private static Map<String, String> data() {
        Map<String, String> data = new LinkedHashMap<>();
        data.put("title", "Weekly review");
        data.put("body", "Ready when you are.");
        data.put("delivery_id", "delivery-1");
        data.put("deep_link", "{\"conversationId\":\"conversation-1\"}");
        return data;
    }

    @Test
    public void carriesEveryDataKeyAndTheMessageIdTheWebHandlerKeysOn() {
        Map<String, String> extras = PushTapIntents.tapExtras(data(), "message-1");

        Map<String, String> expected = data();
        expected.put(PushTapIntents.MESSAGE_ID_EXTRA, "message-1");
        assertEquals(expected, extras);
    }

    @Test
    public void fallsBackToTheDeliveryIdWhenFirebaseGivesNoMessageId() {
        assertEquals("delivery-1", PushTapIntents.tapExtras(data(), null).get(PushTapIntents.MESSAGE_ID_EXTRA));
        assertEquals("delivery-1", PushTapIntents.tapExtras(data(), " ").get(PushTapIntents.MESSAGE_ID_EXTRA));
    }

    @Test
    public void omitsTheMessageIdWhenThereIsNothingToRouteWith() {
        Map<String, String> data = data();
        data.remove("delivery_id");

        assertFalse(PushTapIntents.tapExtras(data, null).containsKey(PushTapIntents.MESSAGE_ID_EXTRA));
        assertEquals(
            PushTapIntents.MESSAGE_ID_EXTRA + " only",
            1,
            PushTapIntents.tapExtras(null, "message-1").size()
        );
    }
}
