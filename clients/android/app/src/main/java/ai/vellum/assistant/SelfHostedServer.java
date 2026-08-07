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
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class SelfHostedServer {
    private static final String CONFIG_DIRECTORY = "capacitor-self-hosted";
    private static final String CONFIG_FILE = "capacitor.config.json";
    private static final String PREFERENCES_NAME = "self_hosted_server";
    private static final String SERVER_URL_KEY = "server_url";
    private static final String SERVERS_KEY = "servers";
    private static final String APP_ENTRY_SEGMENT = "/assistant";

    /** The active slot the shell serves, plus every server it has paired with. */
    interface Store {
        String read();

        boolean write(String value);

        void clear();

        String readServers();

        void writeServers(String value);
    }

    /** A canonical server base plus the optional label the chooser shows. */
    static final class Entry {
        final String name;
        final String url;

        Entry(String name, String url) {
            this.name = name;
            this.url = url;
        }
    }

    private SelfHostedServer() {}

    static URI configured(Context context) {
        return configured(new PreferencesStore(context));
    }

    static URI configured(Store store) {
        return validate(store.read());
    }

    static boolean store(Context context, URI server) {
        return store(new PreferencesStore(context), server);
    }

    static boolean store(Store store, URI server) {
        URI validated = canonical(server);
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

    static List<Entry> servers(Context context) {
        return servers(new PreferencesStore(context));
    }

    /**
     * The remembered list. Urls re-canonicalize on read so pre-canonical
     * duplicates collapse (first wins), and an active server missing from the
     * list joins it unnamed, so a shell paired before the list existed still
     * lists what it is serving.
     */
    static List<Entry> servers(Store store) {
        List<Entry> entries = new ArrayList<>();
        for (Entry item : decode(store.readServers())) {
            URI url = validate(item.url);
            if (url == null || indexOf(entries, url.toASCIIString()) >= 0) {
                continue;
            }
            entries.add(new Entry(item.name, url.toASCIIString()));
        }
        URI active = configured(store);
        if (active != null && indexOf(entries, active.toASCIIString()) < 0) {
            entries.add(new Entry(null, active.toASCIIString()));
        }
        return entries;
    }

    static void append(Context context, URI server, String name) {
        append(new PreferencesStore(context), server, name);
    }

    /**
     * Remember a server, deduped by url. A named re-append renames; a nameless
     * one keeps the stored label, so switching never wipes a name.
     */
    static void append(Store store, URI server, String name) {
        URI validated = canonical(server);
        if (validated == null) {
            return;
        }
        List<Entry> entries = servers(store);
        String url = validated.toASCIIString();
        String label = normalizeName(name);
        int index = indexOf(entries, url);
        if (index < 0) {
            entries.add(new Entry(label, url));
        } else if (label != null) {
            entries.set(index, new Entry(label, url));
        }
        store.writeServers(encode(entries));
    }

    static boolean remove(Context context, URI server) {
        return remove(new PreferencesStore(context), server);
    }

    /**
     * Forget a server, clearing the active slot when it was the active one and
     * answering whether it was, so the caller knows to reload the shell.
     */
    static boolean remove(Store store, URI server) {
        URI validated = canonical(server);
        if (validated == null) {
            return false;
        }
        List<Entry> entries = servers(store);
        int index = indexOf(entries, validated.toASCIIString());
        if (index >= 0) {
            entries.remove(index);
            store.writeServers(encode(entries));
        }
        boolean wasActive = validated.equals(configured(store));
        if (wasActive) {
            clear(store);
        }
        return wasActive;
    }

    /**
     * The SPA entry point for a server base, {@code <base>/assistant}. The
     * ingress redirects a bare {@code /} to an absolute {@code /assistant/},
     * which drops a hosting prefix ({@code https://host/assistant-123} landing
     * on {@code https://host/assistant/}), so the segment is appended here. The
     * baked Vellum Cloud url already carries it and comes back unchanged.
     */
    static URI appEntry(URI server) {
        String base = server.toASCIIString();
        if (base.endsWith(APP_ENTRY_SEGMENT)) {
            return server;
        }
        try {
            return new URI(base + APP_ENTRY_SEGMENT);
        } catch (URISyntaxException exception) {
            return server;
        }
    }

    /** {@link #validate} for an already-parsed url, which re-canonicalizes it. */
    private static URI canonical(URI server) {
        return validate(server == null ? null : server.toASCIIString());
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
        if (!"https".equals(scheme) && !("http".equals(scheme) && isLocalDevelopmentHost(host))) {
            return null;
        }

        if (containsEncodedDotSegment(parsed.getRawPath())) {
            return null;
        }
        URI normalized = parsed.normalize();
        if (containsDotSegment(normalized.getRawPath())) {
            return null;
        }
        String path = normalizePath(normalized.getRawPath());
        try {
            return new URI(scheme + "://" + formatAuthority(scheme, host, parsed.getPort()) + path);
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

        String basePath = normalizePath(server.getRawPath());
        String candidatePath = normalizePath(candidate.getRawPath());
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
            && normalizePath(expected.getRawPath()).equals(normalizePath(actual.getRawPath()));
    }

    static CapConfig overrideCapacitorConfig(Context context, URI server) throws IOException, JSONException {
        String source = readAsset(context, CONFIG_FILE);
        JSONObject root = new JSONObject(source);
        JSONObject serverConfig = root.getJSONObject("server");
        serverConfig.put("url", appEntry(server).toASCIIString());

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
        return defaultPort(uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US));
    }

    private static String normalizePath(String rawPath) {
        if (rawPath == null || rawPath.isEmpty() || "/".equals(rawPath)) {
            return "";
        }
        String normalized = rawPath;
        while (normalized.endsWith("/") && normalized.length() > 1) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        StringBuilder canonical = new StringBuilder(normalized.length());
        for (int index = 0; index < normalized.length(); index++) {
            char item = normalized.charAt(index);
            canonical.append(item);
            if (item == '%' && index + 2 < normalized.length()) {
                canonical.append(Character.toUpperCase(normalized.charAt(++index)));
                canonical.append(Character.toUpperCase(normalized.charAt(++index)));
            }
        }
        return canonical.toString();
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

    private static boolean containsDotSegment(String rawPath) {
        if (rawPath == null) {
            return false;
        }
        for (String segment : rawPath.split("/", -1)) {
            if (".".equals(segment) || "..".equals(segment)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The scheme's default port is dropped so the canonical form matches the web
     * store's {@code normalizeOriginUrl}, which builds from {@code URL.origin}
     * and collapses it. Both sides key the remembered list on this string.
     */
    private static String formatAuthority(String scheme, String host, int port) {
        String authorityHost = host.indexOf(':') >= 0 && !host.startsWith("[") ? "[" + host + "]" : host;
        if (port < 0 || port == defaultPort(scheme)) {
            return authorityHost;
        }
        return authorityHost + ":" + port;
    }

    private static int defaultPort(String scheme) {
        return "https".equals(scheme) ? 443 : 80;
    }

    private static boolean isLocalDevelopmentHost(String host) {
        return "localhost".equals(host) || "127.0.0.1".equals(host) || "10.0.2.2".equals(host);
    }

    private static int indexOf(List<Entry> entries, String url) {
        for (int index = 0; index < entries.size(); index++) {
            if (entries.get(index).url.equals(url)) {
                return index;
            }
        }
        return -1;
    }

    /** Trim a label and collapse an empty one to null. */
    private static String normalizeName(String name) {
        if (name == null) {
            return null;
        }
        String trimmed = name.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /**
     * Anything that is not a JSON array of url-carrying objects reads as empty
     * rather than as an error, so a corrupt preference costs the list rather
     * than the launch.
     */
    private static List<Entry> decode(String raw) {
        List<Entry> entries = new ArrayList<>();
        if (raw == null || raw.isEmpty()) {
            return entries;
        }
        final JSONArray items;
        try {
            items = new JSONArray(raw);
        } catch (JSONException exception) {
            return entries;
        }
        for (int index = 0; index < items.length(); index++) {
            JSONObject item = items.optJSONObject(index);
            String url = item == null ? null : item.optString("url", null);
            if (url != null) {
                entries.add(new Entry(normalizeName(item.optString("name", null)), url));
            }
        }
        return entries;
    }

    private static String encode(List<Entry> entries) {
        JSONArray items = new JSONArray();
        for (Entry entry : entries) {
            JSONObject item = new JSONObject();
            try {
                item.put("url", entry.url);
                if (entry.name != null) {
                    item.put("name", entry.name);
                }
            } catch (JSONException exception) {
                continue;
            }
            items.put(item);
        }
        return items.toString();
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
        public void writeServers(String value) {
            preferences.edit().putString(SERVERS_KEY, value).commit();
        }
    }
}
