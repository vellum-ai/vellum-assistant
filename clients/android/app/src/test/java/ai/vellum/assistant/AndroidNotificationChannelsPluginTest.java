package ai.vellum.assistant;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AndroidNotificationChannelsPluginTest {
    /**
     * A channel that merely exists is not a channel to alert on: the voice
     * session channel is IMPORTANCE_LOW with no badge, and Firebase's fallback
     * channel is whatever the OS made of it.
     */
    @Test
    public void onlyTheAlertsChannelIsOneAPayloadMayName() {
        assertTrue(
            AndroidNotificationChannelsPlugin.isAlertChannelId(
                AndroidNotificationChannelsPlugin.ALERTS_CHANNEL_ID
            )
        );
        assertFalse(AndroidNotificationChannelsPlugin.isAlertChannelId("voice_session_status"));
        assertFalse(AndroidNotificationChannelsPlugin.isAlertChannelId("fcm_fallback_notification_channel"));
        assertFalse(AndroidNotificationChannelsPlugin.isAlertChannelId(null));
    }
}
