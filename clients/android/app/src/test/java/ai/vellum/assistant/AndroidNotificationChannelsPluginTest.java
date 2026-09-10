package ai.vellum.assistant;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AndroidNotificationChannelsPluginTest {
    /**
     * A channel that merely exists is not a channel to alert on: the voice
     * session channel is IMPORTANCE_LOW with no badge, and Firebase's fallback
     * channel is whatever the OS made of it. Naming one is a platform bug, so
     * it earns a log line rather than a user-visible failure report, and one
     * line rather than one per push.
     */
    @Test
    public void warnsOncePerChannelIdAndNeverForTheAlertsChannel() {
        assertFalse(
            AndroidNotificationChannelsPlugin.firstWarningFor(
                AndroidNotificationChannelsPlugin.ALERTS_CHANNEL_ID
            )
        );
        assertTrue(AndroidNotificationChannelsPlugin.firstWarningFor("voice_session_status"));
        assertFalse(
            "already warned",
            AndroidNotificationChannelsPlugin.firstWarningFor("voice_session_status")
        );
        assertTrue(
            AndroidNotificationChannelsPlugin.firstWarningFor(
                "fcm_fallback_notification_channel"
            )
        );
        assertTrue("unnamed", AndroidNotificationChannelsPlugin.firstWarningFor(null));
        assertFalse(
            "already warned",
            AndroidNotificationChannelsPlugin.firstWarningFor(null)
        );
    }
}
