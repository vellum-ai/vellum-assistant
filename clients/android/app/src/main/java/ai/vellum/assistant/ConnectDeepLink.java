package ai.vellum.assistant;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

final class ConnectDeepLink {
    private static final String CONNECT_HOST = "connect";

    private final URI server;
    private final URI pairPage;
    private final String name;

    private ConnectDeepLink(URI server, URI pairPage, String name) {
        this.server = server;
        this.pairPage = pairPage;
        this.name = name;
    }

    static boolean handles(String raw, String expectedScheme) {
        if (raw == null) {
            return false;
        }
        int schemeEnd = raw.indexOf(':');
        if (schemeEnd <= 0 || !expectedScheme.equalsIgnoreCase(raw.substring(0, schemeEnd))) {
            return false;
        }
        int authorityStart = schemeEnd + 3;
        if (authorityStart > raw.length() || !raw.regionMatches(schemeEnd + 1, "//", 0, 2)) {
            return false;
        }
        int authorityEnd = raw.length();
        for (char delimiter : new char[] { '/', '?', '#' }) {
            int index = raw.indexOf(delimiter, authorityStart);
            if (index >= 0 && index < authorityEnd) {
                authorityEnd = index;
            }
        }
        return CONNECT_HOST.equalsIgnoreCase(raw.substring(authorityStart, authorityEnd));
    }

    static ConnectDeepLink parse(String raw, String expectedScheme) {
        URI uri = parseUri(raw);
        if (uri == null || !handles(raw, expectedScheme)) {
            return null;
        }
        String path = uri.getPath();
        if (path != null && !path.isEmpty() && !"/".equals(path)) {
            return null;
        }

        Map<String, String> query = parseQuery(uri.getRawQuery());
        if (query == null) {
            return null;
        }
        URI server = SelfHostedServer.validate(query.get("url"));
        String code = query.get("code");
        if (server == null || code == null || code.isEmpty()) {
            return null;
        }

        URI pairPage = buildPairPage(server, code);
        if (pairPage == null) {
            return null;
        }
        return new ConnectDeepLink(server, pairPage, SelfHostedServer.normalizedName(query.get("name")));
    }

    URI server() {
        return server;
    }

    URI pairPage() {
        return pairPage;
    }

    String name() {
        return name;
    }

    private static URI parseUri(String raw) {
        if (raw == null) {
            return null;
        }
        try {
            return new URI(raw);
        } catch (URISyntaxException exception) {
            return null;
        }
    }

    private static Map<String, String> parseQuery(String rawQuery) {
        if (rawQuery == null || rawQuery.isEmpty()) {
            return null;
        }
        Map<String, String> values = new HashMap<>();
        for (String pair : rawQuery.split("&")) {
            int separator = pair.indexOf('=');
            if (separator <= 0) {
                return null;
            }
            String key = decode(pair.substring(0, separator));
            String value = decode(pair.substring(separator + 1));
            if (key == null || value == null || values.put(key, value) != null) {
                return null;
            }
        }
        return values;
    }

    private static String decode(String value) {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8.name());
        } catch (IllegalArgumentException exception) {
            return null;
        } catch (java.io.UnsupportedEncodingException exception) {
            throw new IllegalStateException("UTF-8 is unavailable", exception);
        }
    }

    private static URI buildPairPage(URI server, String code) {
        String base = server.toASCIIString();
        String pairUrl = base + "/assistant/pair#device_code=" + encodeFragmentValue(code);
        try {
            return new URI(pairUrl);
        } catch (URISyntaxException exception) {
            return null;
        }
    }

    private static String encodeFragmentValue(String value) {
        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        for (byte item : value.getBytes(StandardCharsets.UTF_8)) {
            int unsigned = item & 0xff;
            if (isUnreserved(unsigned)) {
                encoded.write(unsigned);
            } else {
                encoded.write('%');
                String hex = Integer.toHexString(unsigned).toUpperCase(Locale.US);
                if (hex.length() == 1) {
                    encoded.write('0');
                }
                for (int index = 0; index < hex.length(); index++) {
                    encoded.write(hex.charAt(index));
                }
            }
        }
        return new String(encoded.toByteArray(), StandardCharsets.US_ASCII);
    }

    private static boolean isUnreserved(int value) {
        return (value >= 'a' && value <= 'z')
            || (value >= 'A' && value <= 'Z')
            || (value >= '0' && value <= '9')
            || value == '-'
            || value == '.'
            || value == '_'
            || value == '~';
    }
}
