package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.JSObject;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.Test;

public class NativeAuthPluginTest {
    private static final String BASE_URL = "https://dev-assistant.vellum.ai";

    @Test
    public void persistedFlowFieldsRoundTrip() {
        Map<String, String> attribution = new LinkedHashMap<>();
        attribution.put("utm_source", "google");
        attribution.put("utm_campaign", "spring sale & more");
        NativeAuthPlugin.PersistedFlow flow = new NativeAuthPlugin.PersistedFlow(
            BASE_URL,
            "client-123",
            "verifier-abc",
            "state-xyz",
            "/assistant/conversations",
            attribution
        );

        NativeAuthPlugin.PersistedFlow restored =
            NativeAuthPlugin.PersistedFlow.fromFields(flow.toFields());

        assertEquals(BASE_URL, restored.baseURL);
        assertEquals("client-123", restored.clientId);
        assertEquals("verifier-abc", restored.codeVerifier);
        assertEquals("state-xyz", restored.state);
        assertEquals("/assistant/conversations", restored.postAuthDestination);
        assertEquals(attribution, restored.attribution);
    }

    /** The field names are a persisted format; an upgraded install reads them back. */
    @Test
    public void storedFieldsKeepAttributionAndDestinationApart() {
        NativeAuthPlugin.PersistedFlow flow = new NativeAuthPlugin.PersistedFlow(
            BASE_URL,
            "client-123",
            "verifier-abc",
            "state-xyz",
            "/assistant",
            Collections.singletonMap("gclid", "abc123")
        );

        Map<String, String> fields = flow.toFields();

        assertEquals("gclid=abc123", fields.get("attribution"));
        assertEquals("/assistant", fields.get("destination"));
        assertEquals(BASE_URL, fields.get("base_url"));
        assertEquals("client-123", fields.get("client_id"));
        assertEquals("verifier-abc", fields.get("code_verifier"));
        assertEquals("state-xyz", fields.get("state"));
    }

    @Test
    public void aFlowWithoutAttributionRestoresToAnEmptyMap() {
        Map<String, String> fields = new NativeAuthPlugin.PersistedFlow(
            BASE_URL,
            "client-123",
            "verifier-abc",
            "state-xyz",
            "/assistant",
            new LinkedHashMap<String, String>()
        ).toFields();

        assertEquals("", fields.get("attribution"));
        assertTrue(NativeAuthPlugin.PersistedFlow.fromFields(fields).attribution.isEmpty());
    }

    @Test
    public void emptyStoredFieldsRestoreToARejectableFlow() {
        NativeAuthPlugin.PersistedFlow restored =
            NativeAuthPlugin.PersistedFlow.fromFields(new LinkedHashMap<String, String>());

        assertEquals("", restored.baseURL);
        assertNull(restored.clientId);
        assertNull(restored.codeVerifier);
        assertNull(restored.state);
        assertEquals("/assistant", restored.postAuthDestination);
        assertTrue(restored.attribution.isEmpty());
    }

    @Test
    public void anOffSiteStoredDestinationFallsBackToTheDefault() {
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("destination", "//evil.example/phish");

        assertEquals(
            "/assistant",
            NativeAuthPlugin.PersistedFlow.fromFields(fields).postAuthDestination
        );
    }

    @Test
    public void readAttributionFiltersAndTruncatesThroughTheAllowlist() {
        String overlong =
            new String(new char[Attribution.VALUE_MAX_LENGTH + 40]).replace('\0', 'a');
        JSObject source = new JSObject();
        source.put("utm_source", "google");
        source.put("utm_campaign", overlong);
        source.put("sessionToken", "secret");
        source.put("utm_medium", "");

        Map<String, String> fields = NativeAuthPlugin.readAttribution(source);

        assertEquals(2, fields.size());
        assertEquals("google", fields.get("utm_source"));
        assertEquals(
            overlong.substring(0, Attribution.VALUE_MAX_LENGTH),
            fields.get("utm_campaign")
        );
    }

    @Test
    public void readAttributionOfNothingIsAnEmptyMap() {
        assertTrue(NativeAuthPlugin.readAttribution(null).isEmpty());
        assertTrue(NativeAuthPlugin.readAttribution(new JSObject()).isEmpty());
    }
}
