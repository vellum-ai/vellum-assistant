package ai.vellum.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.AtomicFile;
import com.getcapacitor.CapConfig;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class SelfHostedServer {
    private static final String CONFIG_DIRECTORY = "capacitor-self-hosted";
    private static final String CONFIG_FILE = "capacitor.config.json";
    private static final String PREFERENCES_NAME = "self_hosted_server";
    private static final String SERVER_URL_KEY = "server_url";
    private static final String SERVERS_KEY = "servers";

    /** Serializes every read-modify-write of the servers list. */
    private static final Object listLock = new Object();

    interface Store {
        String read();

        boolean write(String value);

        void clear();

        String readServers();

        void writeServers(String json);
    }

    /** A remembered self-hosted server: a canonical url plus an optional user-facing label. */
    static final class Entry {
        final String name;
        final String url;

        Entry(String name, String url) {
            this.name = name;
            this.url = url;
        }

        @Override
        public boolean equals(Object other) {
            return other instanceof Entry entry && Objects.equals(name, entry.name) && Objects.equals(url, entry.url);
        }

        @Override
        public int hashCode() {
            return Objects.hash(name, url);
        }
    }

    private SelfHostedServer() {}

    static URI configured(Context context) {
        return configured(new PreferencesStore(context));
    }

    static URI configured(Store store) {
        return validate(store.read());
    }

    static boolean store(Store store, URI server) {
        URI validated = validate(server == null ? null : server.toASCIIString());
        if (validated == null) {
            return false;
        }
        return store.write(validated.toASCIIString());
    }

    static void clear(Context context) {
        clear(new PreferencesStore(context));
    }

    static void clear(Store store) {
        store.clear();
    }

    /**
     * Canonical identity of a validated server URL, shared with the web chooser's
     * remembered-origins store (normalizeOriginUrl) and iOS: the scheme-default
     * port is collapsed, everything else is already normalized by validate.
     */
    static URI canonicalize(URI validated) {
        int port = validated.getPort();
        String scheme = validated.getScheme();
        boolean schemeDefaultPort = ("https".equals(scheme) && port == 443) || ("http".equals(scheme) && port == 80);
        if (!schemeDefaultPort) {
            return validated;
        }
        try {
            return new URI(scheme + "://" + validated.getHost() + normalizePath(validated.getRawPath()));
        } catch (URISyntaxException exception) {
            return validated;
        }
    }

    /** canonicalize as the string used for list entries and equality. */
    static String canonicalString(URI validated) {
        return canonicalize(validated).toASCIIString();
    }

    static List<Entry> servers(Context context) {
        return servers(new PreferencesStore(context));
    }

    /**
     * The remembered server list, entries keyed by canonical URL. Entries failing
     * validate are dropped, stored urls re-canonicalize on read (deduping any
     * pre-canonical duplicates, first entry wins), and a legacy active URL absent
     * from the stored list is included (name null) without writing back until the
     * next mutation.
     */
    static List<Entry> servers(Store store) {
        List<Entry> entries = new ArrayList<>();
        String raw = store.readServers();
        if (raw != null) {
            try {
                JSONArray stored = new JSONArray(raw);
                for (int index = 0; index < stored.length(); index++) {
                    JSONObject item = stored.optJSONObject(index);
                    URI url = item == null ? null : validate(item.optString("url", null));
                    if (url == null) {
                        continue;
                    }
                    String canonical = canonicalString(url);
                    if (indexOfUrl(entries, canonical) < 0) {
                        // isNull guards platform org.json, whose optString
                        // stringifies JSON null to "null". The AOSP-derived
                        // test artifact shares that behavior, so the unnamed
                        // read is test-covered.
                        String name = item.isNull("name") ? null : item.optString("name", null);
                        entries.add(new Entry(normalizedName(name), canonical));
                    }
                }
            } catch (JSONException exception) {
                // A corrupt list reads as empty; the active slot below still surfaces.
            }
        }
        URI active = configured(store);
        if (active != null) {
            String canonical = canonicalString(active);
            if (indexOfUrl(entries, canonical) < 0) {
                entries.add(new Entry(null, canonical));
            }
        }
        return entries;
    }

    static void append(Context context, URI url, String name) {
        append(new PreferencesStore(context), url, name);
    }

    /**
     * Remember an origin, deduped by canonical URL. A re-append with a name
     * updates the label; a nameless re-append keeps the existing one.
     */
    static void append(Store store, URI url, String name) {
        synchronized (listLock) {
            List<Entry> entries = servers(store);
            String canonical = canonicalString(url);
            String label = normalizedName(name);
            int index = indexOfUrl(entries, canonical);
            if (index < 0) {
                entries.add(new Entry(label, canonical));
            } else if (label != null) {
                entries.set(index, new Entry(label, canonical));
            }
            persist(store, entries);
        }
    }

    static void activate(Context context, URI url, String name) {
        activate(new PreferencesStore(context), url, name);
    }

    /** Write the active slot and remember the origin as one atomic mutation. */
    static void activate(Store store, URI url, String name) {
        synchronized (listLock) {
            store(store, url);
            append(store, url, name);
        }
    }

    static boolean removeEntry(Context context, URI url) {
        return removeEntry(new PreferencesStore(context), url);
    }

    /**
     * Forget an origin, matched by canonical URL. When it is also the active
     * slot, the slot is cleared too; returns whether that happened.
     */
    static boolean removeEntry(Store store, URI url) {
        synchronized (listLock) {
            List<Entry> entries = servers(store);
            String canonical = canonicalString(url);
            int index = indexOfUrl(entries, canonical);
            if (index >= 0) {
                entries.remove(index);
            }
            persist(store, entries);
            if (isActive(store, url)) {
                clear(store);
                return true;
            }
            return false;
        }
    }

    /** Whether a URL canonically matches the active slot. */
    static boolean isActive(Store store, URI url) {
        URI active = configured(store);
        return active != null && url != null && canonicalString(active).equals(canonicalString(url));
    }

    /**
     * The SPA entry point for a server base, {@code <base>/assistant}. The
     * ingress redirects a bare base to a prefixless {@code /assistant/},
     * dropping a hosting prefix, so the segment is appended here instead,
     * mirroring iOS {@code appEntryURL}. Stored identity keeps the bare base.
     */
    static URI appEntryUrl(URI base) {
        String path = base.getRawPath();
        if (path != null && path.endsWith("/assistant")) {
            return base;
        }
        try {
            return new URI(base.toASCIIString() + "/assistant");
        } catch (URISyntaxException exception) {
            return base;
        }
    }

    /**
     * The shared shape guard for in-app route paths: non-blank, relative,
     * scheme-less, fragment-free. Callers pass a trimmed path.
     */
    static boolean isRoutePathShape(String path) {
        return path != null
            && !path.isEmpty()
            && !path.startsWith("/")
            && !path.contains("://")
            && !path.contains("#");
    }

    /**
     * A route under an entry URL: {@code <entry>/<path>}, the path's query
     * kept verbatim. Null (caller falls back to the entry) when the path is
     * unusable: blank, absolute, scheme-ful, fragment-carrying, or climbing.
     */
    static String appRoute(String entryUrl, String path) {
        String trimmed = path == null ? "" : path.trim();
        if (!isRoutePathShape(trimmed)) {
            return null;
        }
        int query = trimmed.indexOf('?');
        String pathPart = query < 0 ? trimmed : trimmed.substring(0, query);
        // Query-only input has an empty path component; iOS appRouteURL
        // rejects it, so fall back to the entry URL here too.
        if (pathPart.isEmpty()) {
            return null;
        }
        String[] segments = pathPart.split("/", -1);
        // A colon in the first segment reads as a scheme (mailto:x,
        // host:8080/x), matching the iOS URLComponents rejection.
        if (segments[0].indexOf(':') >= 0) {
            return null;
        }
        for (String segment : segments) {
            if ("..".equals(segment)) {
                return null;
            }
        }
        // iOS splits the percent-decoded path, so %2e%2e reads as ".." there;
        // reject the encoded spelling too or the route could climb the prefix.
        if (containsEncodedDotSegment(pathPart)) {
            return null;
        }
        String base = entryUrl;
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base + "/" + trimmed;
    }

    /** The baked server.url from the bundled Capacitor config, or null when unreadable. */
    static String bakedServerUrl(Context context) {
        try {
            return parseBakedServerUrl(readAsset(context, CONFIG_FILE));
        } catch (Exception exception) {
            return null;
        }
    }

    static String parseBakedServerUrl(String configJson) {
        if (configJson == null) {
            return null;
        }
        try {
            JSONObject server = new JSONObject(configJson).optJSONObject("server");
            String url = server == null ? null : server.optString("url", null);
            return url == null || url.trim().isEmpty() ? null : url;
        } catch (JSONException exception) {
            return null;
        }
    }

    private static int indexOfUrl(List<Entry> entries, String canonicalUrl) {
        for (int index = 0; index < entries.size(); index++) {
            if (entries.get(index).url.equals(canonicalUrl)) {
                return index;
            }
        }
        return -1;
    }

    private static void persist(Store store, List<Entry> entries) {
        JSONArray array = new JSONArray();
        try {
            for (Entry entry : entries) {
                JSONObject item = new JSONObject();
                if (entry.name != null) {
                    item.put("name", entry.name);
                }
                item.put("url", entry.url);
                array.put(item);
            }
        } catch (JSONException exception) {
            return;
        }
        store.writeServers(array.toString());
    }

    /** A user-facing label: trimmed, with blank collapsing to null. */
    static String normalizedName(String name) {
        if (name == null) {
            return null;
        }
        String trimmed = name.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    static URI validate(String raw) {
        if (raw == null) {
            return null;
        }
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) {
            return null;
        }

        final URI parsed;
        try {
            parsed = new URI(trimmed);
        } catch (URISyntaxException exception) {
            return null;
        }
        if (parsed.isOpaque() || parsed.getHost() == null || parsed.getHost().isEmpty()) {
            return null;
        }
        if (parsed.getRawUserInfo() != null || parsed.getRawQuery() != null || parsed.getRawFragment() != null) {
            return null;
        }

        String scheme = parsed.getScheme() == null ? "" : parsed.getScheme().toLowerCase(Locale.US);
        String host = parsed.getHost().toLowerCase(Locale.US);
        // Unicode hosts canonicalize differently here (percent-encoding) than
        // in the web chooser (punycode), so they are rejected outright.
        if (!isAscii(host)) {
            return null;
        }
        if (!"https".equals(scheme) && !("http".equals(scheme) && isLocalDevelopmentHost(host))) {
            return null;
        }

        if (containsEncodedDotSegment(parsed.getRawPath())) {
            return null;
        }
        String resolved = resolveDotSegments(parsed.getRawPath());
        if (resolved == null) {
            return null;
        }
        String path = normalizePath(resolved);
        try {
            return new URI(scheme + "://" + formatAuthority(host, parsed.getPort()) + path);
        } catch (URISyntaxException exception) {
            return null;
        }
    }

    static boolean contains(URI server, String rawUrl) {
        URI candidate = validateNavigationUrl(rawUrl);
        if (server == null || candidate == null) {
            return false;
        }
        if (!server.getScheme().equalsIgnoreCase(candidate.getScheme())) {
            return false;
        }
        if (!server.getHost().equalsIgnoreCase(candidate.getHost())) {
            return false;
        }
        if (effectivePort(server) != effectivePort(candidate)) {
            return false;
        }

        String basePath = foldEscapeCase(normalizePath(server.getRawPath()));
        String candidatePath = foldEscapeCase(normalizePath(candidate.getRawPath()));
        if (basePath.isEmpty()) {
            return true;
        }
        return candidatePath.equals(basePath) || candidatePath.startsWith(basePath + "/");
    }

    static boolean samePage(String expectedUrl, String actualUrl) {
        URI expected = validateNavigationUrl(expectedUrl);
        URI actual = validateNavigationUrl(actualUrl);
        return expected != null
            && actual != null
            && expected.getScheme().equalsIgnoreCase(actual.getScheme())
            && expected.getHost().equalsIgnoreCase(actual.getHost())
            && effectivePort(expected) == effectivePort(actual)
            && foldEscapeCase(normalizePath(expected.getRawPath()))
                .equals(foldEscapeCase(normalizePath(actual.getRawPath())));
    }

    static CapConfig overrideCapacitorConfig(Context context, URI server) throws IOException, JSONException {
        String source = readAsset(context, CONFIG_FILE);
        JSONObject root = new JSONObject(source);
        JSONObject serverConfig = root.getJSONObject("server");
        serverConfig.put("url", appEntryUrl(server).toASCIIString());

        File directory = new File(context.getCacheDir(), CONFIG_DIRECTORY);
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("Unable to create the Capacitor override directory");
        }
        AtomicFile destination = new AtomicFile(new File(directory, CONFIG_FILE));
        FileOutputStream output = null;
        try {
            output = destination.startWrite();
            output.write(root.toString().getBytes(StandardCharsets.UTF_8));
            destination.finishWrite(output);
        } catch (IOException exception) {
            if (output != null) {
                destination.failWrite(output);
            }
            throw exception;
        }
        return CapConfig.loadFromFile(context, directory.getAbsolutePath());
    }

    private static URI validateNavigationUrl(String raw) {
        if (raw == null) {
            return null;
        }
        try {
            URI uri = new URI(raw);
            if (uri.getScheme() == null || uri.getHost() == null) {
                return null;
            }
            return uri;
        } catch (URISyntaxException exception) {
            return null;
        }
    }

    private static int effectivePort(URI uri) {
        if (uri.getPort() >= 0) {
            return uri.getPort();
        }
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private static String normalizePath(String rawPath) {
        if (rawPath == null || rawPath.isEmpty() || "/".equals(rawPath)) {
            return "";
        }
        // Percent-escape casing is preserved, matching the iOS canonicalizer
        // and the web normalizeOriginUrl.
        String normalized = rawPath;
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    /**
     * Uppercase percent-escape hex for comparison only: escape hex digits are
     * case-insensitive per RFC 3986, so navigation checks must match `%2f`
     * against `%2F`, while canonical list identity keeps the original casing.
     */
    private static String foldEscapeCase(String path) {
        StringBuilder folded = new StringBuilder(path.length());
        for (int index = 0; index < path.length(); index++) {
            char item = path.charAt(index);
            folded.append(item);
            if (item == '%' && index + 2 < path.length()) {
                folded.append(Character.toUpperCase(path.charAt(++index)));
                folded.append(Character.toUpperCase(path.charAt(++index)));
            }
        }
        return folded.toString();
    }

    private static boolean containsEncodedDotSegment(String rawPath) {
        if (rawPath == null) {
            return false;
        }
        for (String segment : rawPath.split("/", -1)) {
            StringBuilder decoded = new StringBuilder(segment.length());
            boolean encodedDot = false;
            for (int index = 0; index < segment.length(); index++) {
                if (
                    segment.charAt(index) == '%'
                        && index + 2 < segment.length()
                        && segment.charAt(index + 1) == '2'
                        && Character.toLowerCase(segment.charAt(index + 2)) == 'e'
                ) {
                    decoded.append('.');
                    encodedDot = true;
                    index += 2;
                } else {
                    decoded.append(segment.charAt(index));
                }
            }
            if (encodedDot && (".".contentEquals(decoded) || "..".contentEquals(decoded))) {
                return true;
            }
        }
        return false;
    }

    /**
     * RFC 3986 §5.2.4 dot-segment removal that preserves empty segments, which
     * {@code URI.normalize()} collapses; iOS and the web canonicalizer keep
     * interior duplicate separators as distinct route characters. Returns null
     * when a {@code ..} would climb above the root.
     */
    private static String resolveDotSegments(String rawPath) {
        if (rawPath == null || rawPath.isEmpty()) {
            return "";
        }
        String[] parts = rawPath.split("/", -1);
        List<String> segments = new ArrayList<>();
        for (int index = 1; index < parts.length; index++) {
            String segment = parts[index];
            if (".".equals(segment)) {
                continue;
            }
            if ("..".equals(segment)) {
                if (segments.isEmpty()) {
                    return null;
                }
                segments.remove(segments.size() - 1);
            } else {
                segments.add(segment);
            }
        }
        StringBuilder resolved = new StringBuilder();
        for (String segment : segments) {
            resolved.append('/').append(segment);
        }
        return resolved.toString();
    }

    private static String formatAuthority(String host, int port) {
        String authorityHost = host.indexOf(':') >= 0 && !host.startsWith("[") ? "[" + host + "]" : host;
        return port >= 0 ? authorityHost + ":" + port : authorityHost;
    }

    private static boolean isAscii(String value) {
        for (int index = 0; index < value.length(); index++) {
            if (value.charAt(index) >= 0x80) {
                return false;
            }
        }
        return true;
    }

    private static boolean isLocalDevelopmentHost(String host) {
        return "localhost".equals(host) || "127.0.0.1".equals(host) || "10.0.2.2".equals(host);
    }

    private static String readAsset(Context context, String path) throws IOException {
        try (InputStream input = context.getAssets().open(path); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static final class PreferencesStore implements Store {
        private final SharedPreferences preferences;

        PreferencesStore(Context context) {
            preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
        }

        @Override
        public String read() {
            return preferences.getString(SERVER_URL_KEY, null);
        }

        @Override
        public boolean write(String value) {
            return preferences.edit().putString(SERVER_URL_KEY, value).commit();
        }

        @Override
        public void clear() {
            preferences.edit().remove(SERVER_URL_KEY).commit();
        }

        @Override
        public String readServers() {
            return preferences.getString(SERVERS_KEY, null);
        }

        @Override
        public void writeServers(String json) {
            preferences.edit().putString(SERVERS_KEY, json).commit();
        }
    }
}
