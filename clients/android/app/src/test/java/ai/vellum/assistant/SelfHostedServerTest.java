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
        URI server = SelfHostedServer.validate("https://example.com/tenant%2fabc/");

        assertEquals("https://example.com/tenant%2Fabc", server.toASCIIString());
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

        assertTrue(SelfHostedServer.contains(server, "https://example.com/tenant%2fabc/assistant/pair"));
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
    public void collapsesTheDefaultPortSoCanonicalUrlsMatchTheWebStore() {
        assertEquals("https://example.com/tenant", SelfHostedServer.validate("https://example.com:443/tenant").toASCIIString());
        assertEquals("http://localhost", SelfHostedServer.validate("http://localhost:80").toASCIIString());
    }

    @Test
    public void appendsTheAppEntrySegmentOnlyWhereItIsMissing() {
        assertEquals("https://example.com/assistant", SelfHostedServer.appEntry(URI.create("https://example.com")).toASCIIString());
        assertEquals(
            "https://example.com/assistant-123/assistant",
            SelfHostedServer.appEntry(URI.create("https://example.com/assistant-123")).toASCIIString()
        );
        assertEquals(
            "https://example.com/assistant",
            SelfHostedServer.appEntry(URI.create("https://example.com/assistant")).toASCIIString()
        );
    }

    @Test
    public void remembersServersDedupedByCanonicalUrl() {
        FakeStore store = new FakeStore();

        SelfHostedServer.append(store, SelfHostedServer.validate("https://example.com/assistant-123"), "Work");
        SelfHostedServer.append(store, SelfHostedServer.validate("HTTPS://Example.com:443/assistant-123/"), null);
        SelfHostedServer.append(store, SelfHostedServer.validate("https://other.example.com"), "  ");

        List<SelfHostedServer.Entry> servers = SelfHostedServer.servers(store);
        assertEquals(2, servers.size());
        assertEquals("https://example.com/assistant-123", servers.get(0).url);
        assertEquals("Work", servers.get(0).name);
        assertEquals("https://other.example.com", servers.get(1).url);
        assertNull(servers.get(1).name);
    }

    @Test
    public void keepsTheStoredLabelOnANamelessReAppend() {
        FakeStore store = new FakeStore();
        URI server = SelfHostedServer.validate("https://example.com");

        SelfHostedServer.append(store, server, "Kitchen");
        SelfHostedServer.append(store, server, null);
        assertEquals("Kitchen", SelfHostedServer.servers(store).get(0).name);

        SelfHostedServer.append(store, server, "Studio");
        assertEquals("Studio", SelfHostedServer.servers(store).get(0).name);
    }

    @Test
    public void listsAnActiveServerThatPredatesTheRememberedList() {
        FakeStore store = new FakeStore();
        URI server = SelfHostedServer.validate("https://example.com/assistant-123");
        SelfHostedServer.store(store, server);

        List<SelfHostedServer.Entry> servers = SelfHostedServer.servers(store);
        assertEquals(1, servers.size());
        assertEquals("https://example.com/assistant-123", servers.get(0).url);
    }

    @Test
    public void forgettingTheActiveServerReturnsTheShellToVellumCloud() {
        FakeStore store = new FakeStore();
        URI active = SelfHostedServer.validate("https://example.com");
        URI other = SelfHostedServer.validate("https://other.example.com");
        SelfHostedServer.append(store, active, null);
        SelfHostedServer.append(store, other, null);
        SelfHostedServer.store(store, active);

        assertFalse(SelfHostedServer.remove(store, other));
        assertEquals(1, SelfHostedServer.servers(store).size());
        assertEquals(active, SelfHostedServer.configured(store));

        assertTrue(SelfHostedServer.remove(store, active));
        assertTrue(SelfHostedServer.servers(store).isEmpty());
        assertNull(SelfHostedServer.configured(store));
    }

    @Test
    public void aCorruptListCostsTheListRatherThanTheLaunch() {
        FakeStore store = new FakeStore();
        store.writeServers("not json");
        SelfHostedServer.store(store, SelfHostedServer.validate("https://example.com"));

        List<SelfHostedServer.Entry> servers = SelfHostedServer.servers(store);
        assertEquals(1, servers.size());
        assertEquals("https://example.com", servers.get(0).url);
    }

    @Test
    public void entriesThatNoLongerValidateAreDropped() {
        FakeStore store = new FakeStore();
        store.writeServers("[{\"url\":\"http://example.com\"},{\"name\":\"Ok\",\"url\":\"https://example.com\"},{}]");

        List<SelfHostedServer.Entry> servers = SelfHostedServer.servers(store);
        assertEquals(1, servers.size());
        assertEquals("Ok", servers.get(0).name);
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
        public void writeServers(String value) {
            servers = value;
        }
    }
}
