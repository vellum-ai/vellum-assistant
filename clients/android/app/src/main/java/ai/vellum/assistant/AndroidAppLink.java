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

        if (
            !"https".equalsIgnoreCase(uri.getScheme())
                || uri.getHost() == null
                || !expectedHost.equalsIgnoreCase(uri.getHost())
                || uri.getRawUserInfo() != null
                || (uri.getPort() != -1 && uri.getPort() != 443)
        ) {
            return null;
        }

        return uri;
    }
}
