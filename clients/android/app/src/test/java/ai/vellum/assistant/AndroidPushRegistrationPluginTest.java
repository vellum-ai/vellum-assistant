package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;

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
}
