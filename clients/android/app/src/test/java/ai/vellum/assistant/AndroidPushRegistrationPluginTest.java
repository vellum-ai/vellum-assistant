package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.junit.Test;

public class AndroidPushRegistrationPluginTest {
    @Test
    public void capabilitiesPayloadAdvertisesNativeRenderingOnly() throws JSONException {
        JSObject payload = AndroidPushRegistrationPlugin.capabilitiesPayload();

        JSONArray capabilities = payload.getJSONArray("capabilities");
        assertEquals(1, capabilities.length());
        assertEquals("native-notification-render", capabilities.getString(0));
    }

    /**
     * The renderer asks this instead of holding the web runtime's handler,
     * which the plugin instance outlives. A stale true would hand a push to a
     * torn-down handler and lose it.
     */
    @Test
    public void tracksWhetherTheWebRuntimeHoldsAForegroundHandler() {
        AndroidPushRegistrationPlugin.clearBridgeState();
        assertFalse(AndroidPushRegistrationPlugin.hasForegroundHandler());

        AndroidPushRegistrationPlugin.setForegroundHandler(true);
        assertTrue(AndroidPushRegistrationPlugin.hasForegroundHandler());

        AndroidPushRegistrationPlugin.setForegroundHandler(false);
        assertFalse(AndroidPushRegistrationPlugin.hasForegroundHandler());
    }

    @Test
    public void tracksVersionedNotificationOwnershipSeparately() throws JSONException {
        AndroidPushRegistrationPlugin.clearBridgeState();
        assertFalse(AndroidPushRegistrationPlugin.hasNotificationOwnership());

        int generation = AndroidPushRegistrationPlugin.bridgeGeneration();
        assertTrue(
            AndroidPushRegistrationPlugin.negotiateNotificationOwnership(
                1,
                generation,
                true
            )
        );
        JSObject payload = AndroidPushRegistrationPlugin.notificationOwnershipPayload(true);

        assertEquals(1, payload.getInt("version"));
        assertEquals(generation, payload.getInt("generation"));
        assertTrue(payload.getBoolean("active"));
        assertTrue(payload.getBoolean("accepted"));
        assertFalse(AndroidPushRegistrationPlugin.hasForegroundHandler());

        AndroidPushRegistrationPlugin.clearBridgeState();
        assertFalse(AndroidPushRegistrationPlugin.hasNotificationOwnership());
    }

    @Test
    public void stalePageGenerationCannotRestoreOwnershipAfterBridgeClear() {
        AndroidPushRegistrationPlugin.clearBridgeState();
        int staleGeneration = AndroidPushRegistrationPlugin.bridgeGeneration();
        assertTrue(
            AndroidPushRegistrationPlugin.negotiateNotificationOwnership(
                1,
                staleGeneration,
                true
            )
        );

        AndroidPushRegistrationPlugin.clearBridgeState();
        int currentGeneration = AndroidPushRegistrationPlugin.bridgeGeneration();

        assertFalse(AndroidPushRegistrationPlugin.hasForegroundHandler());
        assertFalse(AndroidPushRegistrationPlugin.hasNotificationOwnership());
        assertFalse(
            AndroidPushRegistrationPlugin.negotiateNotificationOwnership(
                1,
                staleGeneration,
                true
            )
        );
        assertFalse(AndroidPushRegistrationPlugin.hasNotificationOwnership());
        assertTrue(
            AndroidPushRegistrationPlugin.negotiateNotificationOwnership(
                1,
                currentGeneration,
                true
            )
        );
        assertTrue(AndroidPushRegistrationPlugin.hasNotificationOwnership());
        AndroidPushRegistrationPlugin.clearBridgeState();
    }

    @Test
    public void serializedClearWinsOverQueuedLegacyAndVersionedSetters() {
        AndroidPushRegistrationPlugin.clearBridgeState();
        int staleGeneration = AndroidPushRegistrationPlugin.bridgeGeneration();
        List<Runnable> bridgeQueue = new ArrayList<>();

        AndroidPushRegistrationPlugin.clearBridgeStateSerialized(bridgeQueue::add);
        AndroidPushRegistrationPlugin.setForegroundHandler(true);
        assertFalse(
            AndroidPushRegistrationPlugin.negotiateNotificationOwnership(
                1,
                staleGeneration,
                true
            )
        );
        assertTrue(AndroidPushRegistrationPlugin.hasForegroundHandler());

        bridgeQueue.get(0).run();

        assertFalse(AndroidPushRegistrationPlugin.hasForegroundHandler());
        assertFalse(AndroidPushRegistrationPlugin.hasNotificationOwnership());
    }

    @Test
    public void rejectsUnknownOwnershipVersionsWithoutChangingLiveState() {
        AndroidPushRegistrationPlugin.clearBridgeState();

        assertFalse(
            AndroidPushRegistrationPlugin.negotiateNotificationOwnership(
                2,
                AndroidPushRegistrationPlugin.bridgeGeneration(),
                true
            )
        );
        assertFalse(AndroidPushRegistrationPlugin.hasNotificationOwnership());
        int generation = AndroidPushRegistrationPlugin.bridgeGeneration();
        assertTrue(
            AndroidPushRegistrationPlugin.negotiateNotificationOwnership(1, generation, true)
        );
        assertFalse(
            AndroidPushRegistrationPlugin.negotiateNotificationOwnership(2, generation, false)
        );
        assertTrue(AndroidPushRegistrationPlugin.hasNotificationOwnership());
        AndroidPushRegistrationPlugin.clearBridgeState();
    }
}
