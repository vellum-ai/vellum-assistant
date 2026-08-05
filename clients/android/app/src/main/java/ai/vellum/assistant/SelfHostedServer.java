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
import java.util.Locale;
import org.json.JSONException;
import org.json.JSONObject;

final class SelfHostedServer {
    private static final String CONFIG_DIRECTORY = "capacitor-self-hosted";
    private static final String CONFIG_FILE = "capacitor.config.json";
    private static final String PREFERENCES_NAME = "self_hosted_server";
    private static final String SERVER_URL_KEY = "server_url";

    interface Store {
        String read();

        boolean write(String value);

        void clear();
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
        serverConfig.put("url", server.toASCIIString());

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

    private static String formatAuthority(String host, int port) {
        String authorityHost = host.indexOf(':') >= 0 && !host.startsWith("[") ? "[" + host + "]" : host;
        return port >= 0 ? authorityHost + ":" + port : authorityHost;
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
    }
}
