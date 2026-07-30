package ai.vocify.vellumassistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ConnectDeepLinkTest {
    private static final String SCHEME = "vellum-assistant-dev";

    @Test
    public void parsesColdStartConnectLinksAndPreservesServerPrefixes() {
        ConnectDeepLink connect = ConnectDeepLink.parse(
            SCHEME + "://connect?url=https%3A%2F%2Fexample.com%2Fassistant-123%2F&code=device-code",
            SCHEME
        );

        assertEquals("https://example.com/assistant-123", connect.server().toASCIIString());
        assertEquals(
            "https://example.com/assistant-123/assistant/pair#device_code=device-code",
            connect.pairPage().toASCIIString()
        );
    }

    @Test
    public void encodesTheOneTimeCodeOnlyInThePairPageFragment() {
        ConnectDeepLink connect = ConnectDeepLink.parse(
            SCHEME + "://connect?url=https%3A%2F%2Fexample.com&code=code%20with%2Fsymbols",
            SCHEME
        );

        assertEquals("https://example.com", connect.server().toASCIIString());
        assertEquals(
            "https://example.com/assistant/pair#device_code=code%20with%2Fsymbols",
            connect.pairPage().toASCIIString()
        );
    }

    @Test
    public void recognizesMalformedConnectLinksSoOtherHandlersDoNotReceiveThem() {
        String raw = SCHEME + "://connect?url=not-a-url&code=device-code";

        assertTrue(ConnectDeepLink.handles(raw, SCHEME));
        assertNull(ConnectDeepLink.parse(raw, SCHEME));
    }

    @Test
    public void leavesOtherNativeRoutesForTheirExistingHandlers() {
        assertFalse(ConnectDeepLink.handles(SCHEME + "://auth/callback?code=auth-code", SCHEME));
        assertFalse(ConnectDeepLink.handles(SCHEME + "://oauth-complete", SCHEME));
        assertFalse(ConnectDeepLink.handles(SCHEME + "://billing/checkout-complete", SCHEME));
        assertFalse(ConnectDeepLink.handles(SCHEME + "://voice?mode=new", SCHEME));
    }

    @Test
    public void rejectsWrongSchemesDuplicateFieldsAndUnexpectedPaths() {
        assertNull(
            ConnectDeepLink.parse(
                "vellum-assistant://connect?url=https%3A%2F%2Fexample.com&code=device-code",
                SCHEME
            )
        );
        assertNull(
            ConnectDeepLink.parse(
                SCHEME + "://connect?url=https%3A%2F%2Fexample.com&url=https%3A%2F%2Fother.example.com&code=device-code",
                SCHEME
            )
        );
        assertNull(
            ConnectDeepLink.parse(
                SCHEME + "://connect/other?url=https%3A%2F%2Fexample.com&code=device-code",
                SCHEME
            )
        );
    }
}
