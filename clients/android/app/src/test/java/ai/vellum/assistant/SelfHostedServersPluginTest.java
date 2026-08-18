package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.JSObject;
import java.util.Arrays;
import java.util.Collections;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

public class SelfHostedServersPluginTest {
    @Test
    public void emptyStateResolvesEmptyListAndJsonNulls() throws JSONException {
        JSObject payload = SelfHostedServersPlugin.listPayload(Collections.emptyList(), null, null);

        assertEquals(0, payload.getJSONArray("servers").length());
        assertTrue(payload.has("activeUrl"));
        assertTrue(payload.isNull("activeUrl"));
        assertSame(JSONObject.NULL, payload.get("activeUrl"));
        assertTrue(payload.has("bakedUrl"));
        assertTrue(payload.isNull("bakedUrl"));
        assertSame(JSONObject.NULL, payload.get("bakedUrl"));
    }

    @Test
    public void namedEntriesCarryTheNameKey() throws JSONException {
        JSObject payload = SelfHostedServersPlugin.listPayload(
            Collections.singletonList(new SelfHostedServer.Entry("Work", "https://work.example.com")),
            "https://work.example.com",
            "https://app.vellum.ai"
        );

        JSONArray servers = payload.getJSONArray("servers");
        assertEquals(1, servers.length());
        JSONObject entry = servers.getJSONObject(0);
        assertEquals("Work", entry.getString("name"));
        assertEquals("https://work.example.com", entry.getString("url"));
        assertEquals("https://work.example.com", payload.getString("activeUrl"));
        assertEquals("https://app.vellum.ai", payload.getString("bakedUrl"));
    }

    @Test
    public void unnamedEntriesOmitTheNameKeyEntirely() throws JSONException {
        JSObject payload = SelfHostedServersPlugin.listPayload(
            Arrays.asList(
                new SelfHostedServer.Entry(null, "https://one.example.com"),
                new SelfHostedServer.Entry("Two", "https://two.example.com/base")
            ),
            null,
            "https://app.vellum.ai"
        );

        JSONArray servers = payload.getJSONArray("servers");
        assertEquals(2, servers.length());
        JSONObject unnamed = servers.getJSONObject(0);
        assertFalse(unnamed.has("name"));
        assertEquals("https://one.example.com", unnamed.getString("url"));
        JSONObject named = servers.getJSONObject(1);
        assertEquals("Two", named.getString("name"));
        assertEquals("https://two.example.com/base", named.getString("url"));
        assertTrue(payload.isNull("activeUrl"));
        assertEquals("https://app.vellum.ai", payload.getString("bakedUrl"));
    }
}
