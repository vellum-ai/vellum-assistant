package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class VoiceLiveActivityPluginTest {
    @Test
    public void mapsEveryWebSessionPhaseToAnAndroidStatus() {
        assertEquals(
            VoiceLiveActivityPlugin.Status.IDLE,
            VoiceLiveActivityPlugin.Status.fromPhase("connecting")
        );
        assertEquals(
            VoiceLiveActivityPlugin.Status.LISTENING,
            VoiceLiveActivityPlugin.Status.fromPhase("listening")
        );
        assertEquals(
            VoiceLiveActivityPlugin.Status.THINKING,
            VoiceLiveActivityPlugin.Status.fromPhase("transcribing")
        );
        assertEquals(
            VoiceLiveActivityPlugin.Status.THINKING,
            VoiceLiveActivityPlugin.Status.fromPhase("thinking")
        );
        assertEquals(
            VoiceLiveActivityPlugin.Status.SPEAKING,
            VoiceLiveActivityPlugin.Status.fromPhase("speaking")
        );
        assertEquals(
            VoiceLiveActivityPlugin.Status.TERMINAL,
            VoiceLiveActivityPlugin.Status.fromPhase("ending")
        );
        assertEquals(
            VoiceLiveActivityPlugin.Status.TERMINAL,
            VoiceLiveActivityPlugin.Status.fromPhase("idle")
        );
        assertEquals(
            VoiceLiveActivityPlugin.Status.TERMINAL,
            VoiceLiveActivityPlugin.Status.fromPhase("failed")
        );
    }

    @Test
    public void onlyTheTerminalStatusClearsTheNotification() {
        assertFalse(VoiceLiveActivityPlugin.Status.IDLE.terminal);
        assertFalse(VoiceLiveActivityPlugin.Status.LISTENING.terminal);
        assertFalse(VoiceLiveActivityPlugin.Status.THINKING.terminal);
        assertFalse(VoiceLiveActivityPlugin.Status.SPEAKING.terminal);
        assertTrue(VoiceLiveActivityPlugin.Status.TERMINAL.terminal);
    }

    @Test
    public void rejectsUnknownOrMissingPhases() {
        assertNull(VoiceLiveActivityPlugin.Status.fromPhase(null));
        assertNull(VoiceLiveActivityPlugin.Status.fromPhase("paused"));
    }
}
