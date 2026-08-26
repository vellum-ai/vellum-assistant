package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.Test;

public class AttributionTest {
    @Test
    public void parsesAWellFormedReferrer() {
        Map<String, String> fields =
            Attribution.parseQuery("utm_source=google&utm_medium=cpc&gclid=abc123");

        assertEquals(3, fields.size());
        assertEquals("google", fields.get("utm_source"));
        assertEquals("cpc", fields.get("utm_medium"));
        assertEquals("abc123", fields.get("gclid"));
    }

    @Test
    public void decodesPercentEncodedKeysAndValues() {
        Map<String, String> fields =
            Attribution.parseQuery("utm_campaign=spring%20sale&utm%5Fterm=running+shoes");

        assertEquals("spring sale", fields.get("utm_campaign"));
        assertEquals("running shoes", fields.get("utm_term"));
    }

    @Test
    public void dropsUnknownKeysAndEmptyValues() {
        Map<String, String> fields = Attribution.parseQuery(
            "utm_source=google&sessionToken=secret&ref=friend&utm_medium=&fbclid=fb-1"
        );

        assertEquals(2, fields.size());
        assertEquals("google", fields.get("utm_source"));
        assertEquals("fb-1", fields.get("fbclid"));
    }

    @Test
    public void truncatesOverlongValues() {
        String overlong = repeat('a', Attribution.VALUE_MAX_LENGTH + 88);

        String value = Attribution.parseQuery("utm_campaign=" + overlong).get("utm_campaign");

        assertEquals(Attribution.VALUE_MAX_LENGTH, value.length());
        assertEquals(overlong.substring(0, Attribution.VALUE_MAX_LENGTH), value);
    }

    @Test
    public void returnsAnEmptyMapForUnusableInput() {
        assertTrue(Attribution.parseQuery(null).isEmpty());
        assertTrue(Attribution.parseQuery("").isEmpty());
        assertTrue(Attribution.parseQuery("   ").isEmpty());
        assertTrue(Attribution.parseQuery("garbage").isEmpty());
        assertTrue(Attribution.parseQuery("&&&").isEmpty());
    }

    @Test
    public void keepsValidPairsBesideMalformedOnes() {
        Map<String, String> fields = Attribution.parseQuery(
            "=orphan&utm_source=google&utm_campaign=%ZZ&novalue&&gclid=abc123"
        );

        assertEquals(2, fields.size());
        assertEquals("google", fields.get("utm_source"));
        assertEquals("abc123", fields.get("gclid"));
    }

    @Test
    public void filterKeepsOnlyAllowlistedNonEmptyValues() {
        Map<String, String> raw = new LinkedHashMap<>();
        raw.put("gclid", "abc123");
        raw.put("sessionToken", "secret");
        raw.put("utm_source", "google");
        raw.put("utm_medium", "");

        Map<String, String> fields = Attribution.filter(raw);

        assertEquals(2, fields.size());
        assertEquals("google", fields.get("utm_source"));
        assertEquals("abc123", fields.get("gclid"));
    }

    @Test
    public void filterTruncatesOverlongValues() {
        String overlong = repeat('a', Attribution.VALUE_MAX_LENGTH + 88);

        String value = Attribution.filter(
            Collections.singletonMap("utm_campaign", overlong)
        ).get("utm_campaign");

        assertEquals(overlong.substring(0, Attribution.VALUE_MAX_LENGTH), value);
    }

    @Test
    public void filterReturnsAnEmptyMapForUnusableInput() {
        assertTrue(Attribution.filter(null).isEmpty());
        assertTrue(Attribution.filter(new LinkedHashMap<String, String>()).isEmpty());
        assertTrue(Attribution.filter(Collections.singletonMap("ref", "friend")).isEmpty());
    }

    @Test
    public void toQueryPercentEncodesReservedCharacters() {
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("utm_campaign", "spring sale & more");
        fields.put("utm_term", "a=b#c");

        assertEquals(
            "utm_campaign=spring+sale+%26+more&utm_term=a%3Db%23c",
            Attribution.toQuery(fields)
        );
    }

    @Test
    public void toQueryRoundTripsThroughParseQuery() {
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("utm_source", "google");
        fields.put("utm_campaign", "spring sale & more");
        fields.put("li_fat_id", "li/123");

        assertEquals(fields, Attribution.parseQuery(Attribution.toQuery(fields)));
    }

    @Test
    public void toQueryEmitsInKeysOrderAndSkipsEmptyValues() {
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("twclid", "tw-1");
        fields.put("utm_medium", "cpc");
        fields.put("utm_source", "google");
        fields.put("utm_term", "");

        assertEquals("utm_source=google&utm_medium=cpc&twclid=tw-1", Attribution.toQuery(fields));
        assertEquals("", Attribution.toQuery(new LinkedHashMap<String, String>()));
        assertEquals("", Attribution.toQuery(null));
    }

    private static String repeat(char value, int count) {
        StringBuilder builder = new StringBuilder(count);
        for (int index = 0; index < count; index++) {
            builder.append(value);
        }
        return builder.toString();
    }
}
