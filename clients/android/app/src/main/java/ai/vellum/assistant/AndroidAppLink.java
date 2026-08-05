package ai.vellum.assistant;

import java.net.URI;
import java.net.URISyntaxException;

final class AndroidAppLink {
    private AndroidAppLink() {}

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
                return path.startsWith("/assistant/conversations/")
                    || path.startsWith("/assistant/settings/billing/");
        }
    }
}
