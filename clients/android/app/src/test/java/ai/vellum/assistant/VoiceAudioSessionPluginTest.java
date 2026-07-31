package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import android.media.AudioManager;
import org.junit.Test;

public class VoiceAudioSessionPluginTest {
    @Test
    public void permanentFocusLossBeginsFocusLossInterruption() {
        VoiceAudioSessionPlugin.FocusEvent event =
            VoiceAudioSessionPlugin.FocusEvent.fromFocusChange(AudioManager.AUDIOFOCUS_LOSS);
        assertEquals("began", event.type);
        assertEquals("focus-loss", event.reason);
    }

    @Test
    public void transientFocusLossBeginsInterruptionButDuckingIsIgnored() {
        VoiceAudioSessionPlugin.FocusEvent transientEvent =
            VoiceAudioSessionPlugin.FocusEvent.fromFocusChange(
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
            );
        VoiceAudioSessionPlugin.FocusEvent duckingEvent =
            VoiceAudioSessionPlugin.FocusEvent.fromFocusChange(
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
            );
        assertEquals("began", transientEvent.type);
        assertEquals("interruption", transientEvent.reason);
        assertNull(duckingEvent);
    }

    @Test
    public void focusGainEndsWithResumeReason() {
        VoiceAudioSessionPlugin.FocusEvent event =
            VoiceAudioSessionPlugin.FocusEvent.fromFocusChange(AudioManager.AUDIOFOCUS_GAIN);
        assertEquals("ended", event.type);
        assertEquals("resume", event.reason);
    }

    @Test
    public void routeChangesUseTheSharedInterruptionPayload() {
        VoiceAudioSessionPlugin.FocusEvent event =
            VoiceAudioSessionPlugin.FocusEvent.routeChange();
        assertEquals("began", event.type);
        assertEquals("route-change", event.reason);
    }
}
