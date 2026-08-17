package ai.vellum.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.net.URI;
import java.util.List;
import org.junit.Test;

public class SelfHostedServerTest {
    @Test
    public void validatesHttpsAndPreservesNormalizedPathPrefixes() {
        URI server = SelfHostedServer.validate("  HTTPS://Example.COM:8443/tenant/../assistant-123/  ");

        assertEquals("https://example.com:8443/assistant-123", server.toASCIIString());
    }

    @Test
    public void preservesEscapedReservedCharacters() {
        URI lower = SelfHostedServer.validate("https://example.com/tenant%2fabc/");
        URI upper = SelfHostedServer.validate("https://example.com/tenant%2Fabc/");

        assertEquals("https://example.com/tenant%2fabc", lower.toASCIIString());
        assertEquals("https://example.com/tenant%2Fabc", upper.toASCIIString());
    }

    @Test
    public void rejectsEncodedDotSegments() {
        assertNull(SelfHostedServer.validate("https://example.com/tenant/%2E%2e"));
        assertNull(SelfHostedServer.validate("https://example.com/tenant/.%2e"));
    }

    @Test
    public void rejectsParentSegmentsThatRemainAboveRoot() {
        assertNull(SelfHostedServer.validate("https://example.com/tenant/../../../assistant"));
    }

    @Test
    public void rejectsCredentialsQueriesAndFragments() {
        assertNull(SelfHostedServer.validate("https://" + "user:credential@" + "example.com/assistant"));
        assertNull(SelfHostedServer.validate("https://example.com/assistant?code=secret"));
        assertNull(SelfHostedServer.validate("https://example.com/assistant#secret"));
    }

    @Test
    public void permitsCleartextOnlyForExplicitDevelopmentHosts() {
        assertEquals("http://localhost:8787", SelfHostedServer.validate("http://localhost:8787").toString());
        assertEquals("http://10.0.2.2:8787", SelfHostedServer.validate("http://10.0.2.2:8787").toString());
        assertNull(SelfHostedServer.validate("http://example.com"));
        assertNull(SelfHostedServer.validate("http://192.168.1.20:8787"));
    }

    @Test
    public void rejectsNonAsciiHostsButKeepsAsciiAndIpv6LiteralHosts() {
        assertNull(SelfHostedServer.validate("https://münchen.example"));
        assertEquals("https://example.com", SelfHostedServer.validate("https://example.com").toASCIIString());
        assertEquals("https://[::1]:8443", SelfHostedServer.validate("https://[::1]:8443").toASCIIString());
    }

    @Test
    public void storesOnlyValidatedServerBasesAndCanReset() {
        FakeStore store = new FakeStore();
        URI server = SelfHostedServer.validate("https://example.com/assistant-123");

        assertTrue(SelfHostedServer.store(store, server));
        assertEquals("https://example.com/assistant-123", store.value);
        assertEquals(server, SelfHostedServer.configured(store));

        SelfHostedServer.clear(store);
        assertNull(SelfHostedServer.configured(store));
    }

    @Test
    public void invalidStoredValuesCannotReplaceTheLastValidServer() {
        FakeStore store = new FakeStore();
        URI valid = SelfHostedServer.validate("https://example.com/assistant-123");
        SelfHostedServer.store(store, valid);

        assertFalse(SelfHostedServer.store(store, URI.create("http://example.com")));
        assertEquals(valid, SelfHostedServer.configured(store));
    }

    @Test
    public void matchesOnlyNavigationsInsideTheConfiguredPrefix() {
        URI server = URI.create("https://example.com/tenant");

        assertTrue(SelfHostedServer.contains(server, "https://example.com/tenant/assistant/pair"));
        assertFalse(SelfHostedServer.contains(server, "https://example.com/tenant-other"));
        assertFalse(SelfHostedServer.contains(server, "https://other.example.com/tenant"));
    }

    @Test
    public void keepsEscapedSeparatorsDistinctWhenMatchingPrefixes() {
        URI server = SelfHostedServer.validate("https://example.com/tenant%2Fabc");

        assertTrue(SelfHostedServer.contains(server, "https://example.com/tenant%2Fabc/assistant/pair"));
        assertFalse(SelfHostedServer.contains(server, "https://example.com/tenant/abc/assistant/pair"));
    }

    @Test
    public void matchesPairPagesAcrossDefaultPortAndFragmentForms() {
        String pairPage = "https://example.com/tenant/assistant/pair#device_code=device-code";

        assertTrue(
            SelfHostedServer.samePage(
                pairPage,
                "https://example.com:443/tenant/assistant/pair"
            )
        );
        assertFalse(SelfHostedServer.samePage(pairPage, "https://example.com/other/assistant/pair"));
    }

    @Test
    public void canonicalizationCollapsesSchemeDefaultPortsOnly() {
        assertEquals(
            "https://example.com/assistant-123",
            SelfHostedServer.canonicalString(SelfHostedServer.validate("https://example.com:443/assistant-123/"))
        );
        assertEquals(
            "https://example.com:8443/assistant-123",
            SelfHostedServer.canonicalString(SelfHostedServer.validate("https://example.com:8443/assistant-123"))
        );
        assertEquals(
            "http://localhost:8787",
            SelfHostedServer.canonicalString(SelfHostedServer.validate("http://localhost:8787"))
        );
        assertEquals(
            "http://localhost",
            SelfHostedServer.canonicalString(SelfHostedServer.validate("http://localhost:80"))
        );
    }

    @Test
    public void preservesInteriorDuplicateSeparators() {
        assertEquals(
            "https://example.com/tenant//assistant",
            SelfHostedServer.validate("https://example.com/tenant//assistant").toASCIIString()
        );
        assertEquals(
            "https://example.com/tenant//assistant",
            SelfHostedServer.canonicalString(SelfHostedServer.validate("https://example.com/tenant//assistant"))
        );
    }

    @Test
    public void navigationChecksMatchPercentEscapesCaseInsensitively() {
        assertTrue(
            SelfHostedServer.samePage(
                "https://example.com/tenant%2fabc/assistant/pair",
                "https://example.com/tenant%2Fabc/assistant/pair"
            )
        );
        assertTrue(
            SelfHostedServer.contains(
                SelfHostedServer.validate("https://example.com/tenant%2fabc"),
                "https://example.com/tenant%2Fabc/conversations"
            )
        );
        assertFalse(
            SelfHostedServer.contains(
                SelfHostedServer.validate("https://example.com/tenant%2fabc"),
                "https://example.com/tenant/abc/conversations"
            )
        );
    }

    @Test
    public void stripsEveryTrailingSlashLikeIosAndWebCanonicalizers() {
        assertEquals("https://example.com", SelfHostedServer.validate("https://example.com//").toASCIIString());
        assertEquals(
            "https://example.com",
            SelfHostedServer.canonicalString(SelfHostedServer.validate("https://example.com:443///"))
        );
        assertEquals(
            "https://example.com/assistant-123",
            SelfHostedServer.canonicalString(SelfHostedServer.validate("https://example.com/assistant-123//"))
        );
    }

    @Test
    public void appendDedupesByCanonicalUrlAndKeepsLabelsAcrossNamelessReappends() {
        FakeStore store = new FakeStore();
        URI server = SelfHostedServer.validate("https://example.com:443/assistant-123/");

        SelfHostedServer.append(store, server, "  Living Room  ");
        SelfHostedServer.append(store, SelfHostedServer.validate("https://example.com/assistant-123"), null);

        List<SelfHostedServer.Entry> servers = SelfHostedServer.servers(store);
        assertEquals(1, servers.size());
        assertEquals(new SelfHostedServer.Entry("Living Room", "https://example.com/assistant-123"), servers.get(0));

        SelfHostedServer.append(store, server, "Kitchen");
        assertEquals("Kitchen", SelfHostedServer.servers(store).get(0).name);
    }

    @Test
    public void readingDropsInvalidEntriesAndDedupesPreCanonicalDuplicates() {
        FakeStore store = new FakeStore();
        store.servers =
            "[{\"url\":\"http://example.com\"},"
                + "{\"name\":\"First\",\"url\":\"https://example.com:443/assistant-123\"},"
                + "{\"name\":\"Second\",\"url\":\"https://example.com/assistant-123/\"},"
                + "{\"name\":\"\",\"url\":\"https://other.example.com/assistant-456\"}]";

        List<SelfHostedServer.Entry> servers = SelfHostedServer.servers(store);

        assertEquals(2, servers.size());
        assertEquals(new SelfHostedServer.Entry("First", "https://example.com/assistant-123"), servers.get(0));
        assertEquals(new SelfHostedServer.Entry(null, "https://other.example.com/assistant-456"), servers.get(1));
    }

    @Test
    public void readsExplicitJsonNullNamesAsUnnamed() {
        FakeStore store = new FakeStore();
        store.servers = "[{\"name\":null,\"url\":\"https://example.com/assistant-123\"}]";

        List<SelfHostedServer.Entry> servers = SelfHostedServer.servers(store);

        assertEquals(1, servers.size());
        assertEquals(new SelfHostedServer.Entry(null, "https://example.com/assistant-123"), servers.get(0));
    }

    @Test
    public void activateWritesTheActiveSlotAndRemembersTheOrigin() {
        FakeStore store = new FakeStore();
        URI server = SelfHostedServer.validate("https://example.com:443/assistant-123/");

        SelfHostedServer.activate(store, server, "Living Room");

        assertTrue(SelfHostedServer.isActive(store, server));
        List<SelfHostedServer.Entry> servers = SelfHostedServer.servers(store);
        assertEquals(1, servers.size());
        assertEquals(new SelfHostedServer.Entry("Living Room", "https://example.com/assistant-123"), servers.get(0));
    }

    @Test
    public void foldsInLegacyActiveUrlWithoutWritingBack() {
        FakeStore store = new FakeStore();
        SelfHostedServer.store(store, SelfHostedServer.validate("https://example.com:443/assistant-123"));

        List<SelfHostedServer.Entry> servers = SelfHostedServer.servers(store);

        assertEquals(1, servers.size());
        assertEquals(new SelfHostedServer.Entry(null, "https://example.com/assistant-123"), servers.get(0));
        assertNull(store.servers);
    }

    @Test
    public void removingTheActiveEntryClearsTheActiveSlot() {
        FakeStore store = new FakeStore();
        URI active = SelfHostedServer.validate("https://example.com/assistant-123");
        URI other = SelfHostedServer.validate("https://other.example.com/assistant-456");
        SelfHostedServer.append(store, active, "Active");
        SelfHostedServer.append(store, other, "Other");
        SelfHostedServer.store(store, active);

        assertFalse(SelfHostedServer.removeEntry(store, other));
        assertTrue(SelfHostedServer.isActive(store, active));

        assertTrue(SelfHostedServer.removeEntry(store, SelfHostedServer.validate("https://example.com:443/assistant-123")));
        assertNull(SelfHostedServer.configured(store));
        assertTrue(SelfHostedServer.servers(store).isEmpty());
    }

    @Test
    public void appEntryUrlAppendsTheAssistantSegmentPreservingPrefixes() {
        assertEquals(
            "https://example.com/assistant-123/assistant",
            SelfHostedServer.appEntryUrl(SelfHostedServer.validate("https://example.com/assistant-123")).toASCIIString()
        );
        assertEquals(
            "https://example.com/assistant",
            SelfHostedServer.appEntryUrl(SelfHostedServer.validate("https://example.com")).toASCIIString()
        );
        assertEquals(
            "https://example.com/assistant",
            SelfHostedServer.appEntryUrl(SelfHostedServer.validate("https://example.com/assistant")).toASCIIString()
        );
    }

    @Test
    public void appRouteJoinsRelativePathsKeepingQueries() {
        assertEquals(
            "https://host/assistant-123/assistant/select-assistant?noAutoSkip=1",
            SelfHostedServer.appRoute("https://host/assistant-123/assistant", "select-assistant?noAutoSkip=1")
        );
        assertEquals(
            "https://host/assistant/pair",
            SelfHostedServer.appRoute("https://host/assistant/", "pair")
        );
    }

    @Test
    public void appRouteRejectsAbsoluteSchemefulFragmentClimbingAndBlankPaths() {
        assertNull(SelfHostedServer.appRoute("https://host/assistant", "/absolute"));
        assertNull(SelfHostedServer.appRoute("https://host/assistant", "https://evil.example/route"));
        assertNull(SelfHostedServer.appRoute("https://host/assistant", "pair#fragment"));
        assertNull(SelfHostedServer.appRoute("https://host/assistant", "a/../b"));
        assertNull(SelfHostedServer.appRoute("https://host/assistant", "a/%2e%2e/b"));
        assertNull(SelfHostedServer.appRoute("https://host/assistant", "?noAutoSkip=1"));
        assertNull(SelfHostedServer.appRoute("https://host/assistant", "a/.%2E/b"));
        assertNull(SelfHostedServer.appRoute("https://host/assistant", "   "));
    }

    @Test
    public void appRouteRejectsColonsOnlyInTheFirstSegment() {
        assertNull(SelfHostedServer.appRoute("https://host/assistant", "mailto:x"));
        assertNull(SelfHostedServer.appRoute("https://host/assistant", "evil.example:8080/x"));
        assertEquals(
            "https://host/assistant/conversations/abc:def",
            SelfHostedServer.appRoute("https://host/assistant", "conversations/abc:def")
        );
    }

    @Test
    public void parsesBakedServerUrlFromCapacitorConfig() {
        assertEquals(
            "https://www.vellum.ai/assistant",
            SelfHostedServer.parseBakedServerUrl("{\"server\":{\"url\":\"https://www.vellum.ai/assistant\"}}")
        );
        assertNull(SelfHostedServer.parseBakedServerUrl("not json"));
        assertNull(SelfHostedServer.parseBakedServerUrl("{\"server\":{}}"));
        assertNull(SelfHostedServer.parseBakedServerUrl(null));
    }

    private static final class FakeStore implements SelfHostedServer.Store {
        private String value;
        private String servers;

        @Override
        public String read() {
            return value;
        }

        @Override
        public boolean write(String value) {
            this.value = value;
            return true;
        }

        @Override
        public void clear() {
            value = null;
        }

        @Override
        public String readServers() {
            return servers;
        }

        @Override
        public void writeServers(String json) {
            servers = json;
        }
    }
}
