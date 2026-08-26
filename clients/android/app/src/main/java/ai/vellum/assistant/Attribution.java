package ai.vellum.assistant;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** Pure allowlist + query helpers for campaign attribution carried by the Android shell. */
final class Attribution {
    /**
     * Source of truth: `ATTRIBUTION_PARAMS` in
     * `clients/web/src/domains/account/social-auth.ts`. A key added there and
     * not here is silently dropped on Android, so keep both lists identical.
     */
    static final String[] KEYS = {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
        "gclid",
        "gbraid",
        "wbraid",
        "msclkid",
        "fbclid",
        "ttclid",
        "li_fat_id",
        "twclid",
    };

    /** Platform truncates per-field; this only bounds what we put on the wire. */
    static final int VALUE_MAX_LENGTH = 512;

    private Attribution() {}

    /**
     * Allowlisted, non-empty, truncated fields of {@code raw}, in
     * {@link #KEYS} order. Anything else the caller supplied is dropped.
     */
    static Map<String, String> filter(Map<String, String> raw) {
        Map<String, String> fields = new LinkedHashMap<>();
        if (raw == null) {
            return fields;
        }
        for (String key : KEYS) {
            String value = raw.get(key);
            if (value == null || value.isEmpty()) {
                continue;
            }
            fields.put(key, truncate(value));
        }
        return fields;
    }

    /**
     * {@link #filter} applied to a raw `key=value&...` string. Never null: a
     * malformed pair is skipped so one garbage segment cannot discard the
     * whole referrer.
     */
    static Map<String, String> parseQuery(String raw) {
        Map<String, String> decoded = new LinkedHashMap<>();
        if (raw == null) {
            return decoded;
        }
        for (String pair : raw.split("&")) {
            int separator = pair.indexOf('=');
            if (separator <= 0) {
                continue;
            }
            String key = decode(pair.substring(0, separator));
            String value = decode(pair.substring(separator + 1));
            if (key != null && value != null) {
                decoded.put(key, value);
            }
        }
        return filter(decoded);
    }

    /** Re-encodes `fields` as a query string in {@link #KEYS} order. */
    static String toQuery(Map<String, String> fields) {
        if (fields == null) {
            return "";
        }
        StringBuilder query = new StringBuilder();
        for (String key : KEYS) {
            String value = fields.get(key);
            if (value == null || value.isEmpty()) {
                continue;
            }
            if (query.length() > 0) {
                query.append('&');
            }
            query.append(encode(key)).append('=').append(encode(value));
        }
        return query.toString();
    }

    private static String truncate(String value) {
        return value.length() <= VALUE_MAX_LENGTH ? value : value.substring(0, VALUE_MAX_LENGTH);
    }

    private static String decode(String value) {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8.name());
        } catch (IllegalArgumentException exception) {
            return null;
        } catch (UnsupportedEncodingException exception) {
            throw new IllegalStateException("UTF-8 is unavailable", exception);
        }
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, StandardCharsets.UTF_8.name());
        } catch (UnsupportedEncodingException exception) {
            throw new IllegalStateException("UTF-8 is unavailable", exception);
        }
    }
}
