package ai.vellum.assistant.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.net.URI;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

public class NativePushRendererTest {
    private static final String NEW_CHAT = "new_chat";
    private static final String OLDEST = "vellum-conversation:assistant-1:conversation-1";
    private static final String MIDDLE = "vellum-conversation:assistant-1:conversation-2";
    private static final String NEWEST = "vellum-conversation:assistant-1:conversation-3";
    private static final String CLAIMED = "vellum-conversation:assistant-1:conversation-4";

    @Test
    public void keepsTwoConversationsByDroppingTheOldestOfOurs() {
        assertEquals(
            Arrays.asList(OLDEST, MIDDLE),
            NativePushRenderer.staleShortcutIds(
                Arrays.asList(NEW_CHAT, OLDEST, MIDDLE, NEWEST),
                CLAIMED
            )
        );
        assertEquals(
            Collections.singletonList(OLDEST),
            NativePushRenderer.staleShortcutIds(Arrays.asList(OLDEST, NEWEST), CLAIMED)
        );
    }

    @Test
    public void dropsNothingWhileTheNewShortcutStillFits() {
        assertEquals(
            Collections.emptyList(),
            NativePushRenderer.staleShortcutIds(Collections.singletonList(OLDEST), CLAIMED)
        );
        assertEquals(
            Collections.emptyList(),
            NativePushRenderer.staleShortcutIds(Collections.singletonList(NEW_CHAT), CLAIMED)
        );
    }

    /** Re-posting a conversation must not evict the shortcut it is about to claim. */
    @Test
    public void neverDropsTheShortcutTheNotificationIsClaiming() {
        List<String> stale = NativePushRenderer.staleShortcutIds(
            Arrays.asList(OLDEST, MIDDLE, NEWEST),
            OLDEST
        );

        assertEquals(Collections.singletonList(MIDDLE), stale);
    }

    /**
     * A shortcut's tap target is the baked cloud app link, which MainActivity
     * refuses while a self-hosted origin is configured, so the notification
     * claims no shortcut at all rather than one that only foregrounds the app.
     */
    @Test
    public void publishesNoConversationShortcutAgainstASelfHostedOrigin() {
        URI selfHosted = URI.create("https://vellum.internal.example.com");

        assertTrue(NativePushRenderer.publishesConversationShortcut("conversation-1", null));
        assertFalse(
            "self-hosted",
            NativePushRenderer.publishesConversationShortcut("conversation-1", selfHosted)
        );
        assertFalse(
            "no conversation to point at",
            NativePushRenderer.publishesConversationShortcut(null, null)
        );
    }

    /** The launcher's own entries are not ours to remove on logout. */
    @Test
    public void ownsOnlyThePrefixedConversationShortcuts() {
        assertEquals(
            Arrays.asList(OLDEST, NEWEST),
            NativePushRenderer.ownedShortcutIds(
                Arrays.asList(NEW_CHAT, OLDEST, "start_voice", NEWEST),
                null
            )
        );
    }
}
