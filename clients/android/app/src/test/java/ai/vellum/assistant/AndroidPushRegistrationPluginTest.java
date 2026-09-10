package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.JSObject;
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
        AndroidPushRegistrationPlugin.clearForegroundHandler();
        assertFalse(AndroidPushRegistrationPlugin.hasForegroundHandler());

        AndroidPushRegistrationPlugin.setForegroundHandler(true);
        assertTrue(AndroidPushRegistrationPlugin.hasForegroundHandler());

        AndroidPushRegistrationPlugin.setForegroundHandler(false);
        assertFalse(AndroidPushRegistrationPlugin.hasForegroundHandler());

        AndroidPushRegistrationPlugin.setForegroundHandler(true);
        AndroidPushRegistrationPlugin.clearForegroundHandler();
        assertFalse("a page load takes it", AndroidPushRegistrationPlugin.hasForegroundHandler());
    }
}
