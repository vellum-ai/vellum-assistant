package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class VoiceDeepLinkTest {
    private static final String SCHEME = "vellum-assistant-dev";

    @Test
    public void parsesExternalStartAndResumeLinksForTheCurrentFlavor() {
        assertEquals(
            VoiceDeepLink.Command.START_VOICE,
            VoiceDeepLink.parse(null, SCHEME + "://voice?mode=new", null, SCHEME)
        );
        assertEquals(
            VoiceDeepLink.Command.RESUME_VOICE,
            VoiceDeepLink.parse(null, SCHEME + "://voice?mode=resume", null, SCHEME)
        );
        assertEquals(
            VoiceDeepLink.Command.START_VOICE,
            VoiceDeepLink.parse(null, SCHEME + "://voice?prompt=hello", null, SCHEME)
        );
    }

    @Test
    public void rejectsWrongSchemesHostsAndPaths() {
        assertEquals(
            VoiceDeepLink.Command.NONE,
            VoiceDeepLink.parse(null, "vellum-assistant://voice?mode=new", null, SCHEME)
        );
        assertEquals(
            VoiceDeepLink.Command.NONE,
            VoiceDeepLink.parse(null, SCHEME + "://connect?mode=new", null, SCHEME)
        );
        assertEquals(
            VoiceDeepLink.Command.NONE,
            VoiceDeepLink.parse(null, SCHEME + "://voice/other?mode=new", null, SCHEME)
        );
    }

    @Test
    public void mapsLauncherTileNotificationAndAppActionCommands() {
        assertEquals(
            VoiceDeepLink.Command.NEW_CHAT,
            VoiceDeepLink.parse(VoiceDeepLink.ACTION_NEW_CHAT, null, null, SCHEME)
        );
        assertEquals(
            VoiceDeepLink.Command.START_VOICE,
            VoiceDeepLink.parse(VoiceDeepLink.ACTION_START_VOICE, null, null, SCHEME)
        );
        assertEquals(
            VoiceDeepLink.Command.RESUME_VOICE,
            VoiceDeepLink.parse(VoiceDeepLink.ACTION_RESUME_VOICE, null, null, SCHEME)
        );
        assertEquals(
            VoiceDeepLink.Command.START_VOICE,
            VoiceDeepLink.parse(
                VoiceDeepLink.ACTION_OPEN_FEATURE,
                null,
                VoiceDeepLink.FEATURE_VOICE_MODE,
                SCHEME
            )
        );
        assertEquals(
            VoiceDeepLink.Command.NEW_CHAT,
            VoiceDeepLink.parse(
                VoiceDeepLink.ACTION_OPEN_FEATURE,
                null,
                VoiceDeepLink.FEATURE_NEW_CHAT,
                SCHEME
            )
        );
    }

    @Test
    public void buildsTheSharedWebVoiceContract() {
        assertTrue(VoiceDeepLink.isVoiceCommand(VoiceDeepLink.Command.START_VOICE));
        assertTrue(VoiceDeepLink.isVoiceCommand(VoiceDeepLink.Command.RESUME_VOICE));
        assertFalse(VoiceDeepLink.isVoiceCommand(VoiceDeepLink.Command.NEW_CHAT));
        assertEquals(
            SCHEME + "://voice?mode=new",
            VoiceDeepLink.voiceUrl(SCHEME, VoiceDeepLink.Command.START_VOICE)
        );
        assertEquals(
            SCHEME + "://voice?mode=resume",
            VoiceDeepLink.voiceUrl(SCHEME, VoiceDeepLink.Command.RESUME_VOICE)
        );
    }

    @Test
    public void suppressesOnlyRecoveredStatusNotificationLaunches() {
        assertTrue(VoiceDeepLink.shouldSuppressRecoveredStatusLaunch(true, true));
        assertFalse(VoiceDeepLink.shouldSuppressRecoveredStatusLaunch(false, true));
        assertFalse(VoiceDeepLink.shouldSuppressRecoveredStatusLaunch(true, false));
    }
}
