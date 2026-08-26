package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;

import java.net.MalformedURLException;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.Test;

public class WorkOSAuthTest {
    private static final String SESSION_URL =
        "https://dev-assistant.vellum.ai/_allauth/app/v1/auth/provider/token";

    @Test
    public void appendsAttributionInAllowlistOrder() throws MalformedURLException {
        Map<String, String> attribution = new LinkedHashMap<>();
        attribution.put("gclid", "abc123");
        attribution.put("utm_source", "google");

        URL url = WorkOSAuth.withAttribution(new URL(SESSION_URL), attribution);

        assertEquals(SESSION_URL + "?utm_source=google&gclid=abc123", url.toString());
    }

    @Test
    public void leavesTheUrlUnchangedWithoutAttribution() throws MalformedURLException {
        URL base = new URL(SESSION_URL);

        assertEquals(SESSION_URL, WorkOSAuth.withAttribution(base, new LinkedHashMap<>()).toString());
        assertEquals(SESSION_URL, WorkOSAuth.withAttribution(base, null).toString());
    }

    @Test
    public void percentEncodesAttributionValues() throws MalformedURLException {
        Map<String, String> attribution = new LinkedHashMap<>();
        attribution.put("utm_campaign", "spring sale & more");
        attribution.put("utm_term", "a=b#c");

        URL url = WorkOSAuth.withAttribution(new URL(SESSION_URL), attribution);

        assertEquals(
            SESSION_URL + "?utm_campaign=spring+sale+%26+more&utm_term=a%3Db%23c",
            url.toString()
        );
    }
}
