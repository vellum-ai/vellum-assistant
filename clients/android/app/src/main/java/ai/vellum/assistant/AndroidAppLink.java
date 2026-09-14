package ai.vellum.assistant;

import androidx.annotation.Nullable;
import java.net.URI;
import java.net.URISyntaxException;

public final class AndroidAppLink {
    private static final String CONVERSATION_PATH = "/assistant/conversations/";
    // A conversation id that survives both ownsPath and the normalization
    // check: no escaping, no relative segment, nothing that rewrites the route.
    private static final String CONVERSATION_ID_PATTERN = "[A-Za-z0-9_-]{1,128}";

    private AndroidAppLink() {}

    /** The link {@link #parse} accepts back for a conversation. */
    @Nullable
    public static String conversationUrl(String host, @Nullable String conversationId) {
        if (conversationId == null || !conversationId.matches(CONVERSATION_ID_PATTERN)) {
            return null;
        }
        return "https://" + host + CONVERSATION_PATH + conversationId;
    }

    static URI parse(String raw, String expectedHost) {
        if (raw == null || expectedHost == null) {
            return null;
        }

        final URI uri;
        try {
            uri = new URI(raw);
        } catch (URISyntaxException exception) {
            return null;
        }
        String path = uri.getRawPath();

        if (
            !"https".equalsIgnoreCase(uri.getScheme())
                || uri.getHost() == null
                || !expectedHost.equalsIgnoreCase(uri.getHost())
                || uri.getRawUserInfo() != null
                || (uri.getPort() != -1 && uri.getPort() != 443)
                || path == null
                || !path.equals(uri.normalize().getRawPath())
                || !ownsPath(path)
        ) {
            return null;
        }

        return uri;
    }

    private static boolean ownsPath(String path) {
        if (path == null || path.indexOf('%') >= 0) {
            return false;
        }
        switch (path) {
            case "/assistant":
            case "/assistant/pair":
            case "/assistant/settings/voice":
            case "/account/oauth/complete":
            case "/assistant/checkout":
            case "/assistant/plans":
            case "/assistant/settings/billing":
            case "/assistant/settings/usage":
                return true;
            default:
                return path.startsWith(CONVERSATION_PATH)
                    || path.startsWith("/assistant/settings/billing/");
        }
    }
}
