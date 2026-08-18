package ai.vellum.assistant;

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
    public void preservesEscapedSeparatorsInPairingPrefixes() {
        ConnectDeepLink connect = ConnectDeepLink.parse(
            SCHEME + "://connect?url=https%3A%2F%2Fexample.com%2Ftenant%252Fabc&code=device-code",
            SCHEME
        );

        assertEquals("https://example.com/tenant%2Fabc", connect.server().toASCIIString());
        assertEquals(
            "https://example.com/tenant%2Fabc/assistant/pair#device_code=device-code",
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
    public void decodesAndTrimsTheOptionalNameLabel() {
        ConnectDeepLink connect = ConnectDeepLink.parse(
            SCHEME + "://connect?url=https%3A%2F%2Fexample.com&code=device-code&name=Living+Room",
            SCHEME
        );

        assertEquals("Living Room", connect.name());
    }

    @Test
    public void preservesEscapedPlusSignsInNameLabels() {
        ConnectDeepLink connect = ConnectDeepLink.parse(
            SCHEME + "://connect?url=https%3A%2F%2Fexample.com&code=device-code&name=A%2BB",
            SCHEME
        );

        assertEquals("A+B", connect.name());
    }

    @Test
    public void collapsesMissingOrBlankNameLabelsToNull() {
        ConnectDeepLink withoutName = ConnectDeepLink.parse(
            SCHEME + "://connect?url=https%3A%2F%2Fexample.com&code=device-code",
            SCHEME
        );
        ConnectDeepLink blankName = ConnectDeepLink.parse(
            SCHEME + "://connect?url=https%3A%2F%2Fexample.com&code=device-code&name=",
            SCHEME
        );

        assertNull(withoutName.name());
        assertEquals("https://example.com", blankName.server().toASCIIString());
        assertNull(blankName.name());
    }

    @Test
    public void ownsConnectLinksThatStrictUriParsingRejects() {
        String raw = SCHEME + "://connect?url=https%3A%2F%2Fexample.com&code=bare value%";

        assertTrue(ConnectDeepLink.handles(raw, SCHEME));
        assertNull(ConnectDeepLink.parse(raw, SCHEME));
    }

    @Test
    public void leavesOtherNativeRoutesForTheirExistingHandlers() {
        assertFalse(ConnectDeepLink.handles(SCHEME + "://auth/callback?code=auth-code", SCHEME));
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
