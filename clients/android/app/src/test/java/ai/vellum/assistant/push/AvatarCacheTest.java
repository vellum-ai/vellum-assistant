package ai.vellum.assistant.push;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class AvatarCacheTest {
    private static final String VELLUM_SHA256 =
        "2fc2a6dd013e7ab41c5a54ab8a254031ff329aa42c5815ac420f1facfe2542d1";
    private static final long NO_DEADLINE = 0;

    @Rule
    public final TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void readsAPayloadUpToTheCap() throws IOException {
        byte[] bytes = new byte[512 * 1024];
        bytes[bytes.length - 1] = 7;

        byte[] read = AvatarCache.readCapped(new ByteArrayInputStream(bytes), NO_DEADLINE);

        assertEquals(bytes.length, read.length);
        assertEquals(7, read[read.length - 1]);
    }

    @Test
    public void rejectsAPayloadOverTheCap() throws IOException {
        byte[] bytes = new byte[512 * 1024 + 1];

        assertNull(AvatarCache.readCapped(new ByteArrayInputStream(bytes), NO_DEADLINE));
    }

    /**
     * The read timeout restarts on every chunk, so a host that answers a byte
     * at a time would otherwise hold the Firebase callback for as many timeouts
     * as the cap allows chunks.
     */
    @Test
    public void givesUpOnAHostThatTricklesPastTheTotalBudget() throws IOException {
        assertNull(AvatarCache.readCapped(tricklingStream(10), 50));
    }

    /** A local file has no host to trickle it, so its read runs to the end. */
    @Test
    public void readsToTheEndWithoutADeadline() throws IOException {
        byte[] read = AvatarCache.readCapped(tricklingStream(10, 5), NO_DEADLINE);

        assertEquals(5, read.length);
    }

    /**
     * The budget spans the response head, so what reaches the body is whatever
     * the head left of it. A read bounded by a fixed budget of its own would
     * read the same amount either way.
     */
    @Test
    public void boundsTheBodyByTheBudgetItIsHanded() throws IOException {
        TricklingStream brief = tricklingStream(10);
        TricklingStream longer = tricklingStream(10);

        assertNull(AvatarCache.readCapped(brief, 50));
        assertNull(AvatarCache.readCapped(longer, 250));

        assertTrue("a larger budget reads more", longer.served > brief.served);
    }

    @Test
    public void acceptsLowercaseSha256HexAndNothingElseAsAFilename() {
        assertEquals(VELLUM_SHA256, AvatarCache.validated(VELLUM_SHA256));
        assertNull(AvatarCache.validated(null));
        assertNull("uppercase", AvatarCache.validated(VELLUM_SHA256.toUpperCase()));
        assertNull("too short", AvatarCache.validated(VELLUM_SHA256.substring(1)));
        assertNull("not hex", AvatarCache.validated(VELLUM_SHA256.replace('0', 'z')));
        assertNull("path traversal", AvatarCache.validated("../../etc/passwd"));
    }

    /** A payload whose digest does not match the pushed hash is never cached. */
    @Test
    public void digestsThePayloadTheWayThePushedHashIsWritten() {
        byte[] bytes = "vellum".getBytes(StandardCharsets.UTF_8);

        assertEquals(VELLUM_SHA256, AvatarCache.sha256Hex(bytes));
        assertNotEquals(VELLUM_SHA256, AvatarCache.sha256Hex(new byte[0]));
    }

    @Test
    public void downsamplesOnlyWhatIsBiggerThanTheLargeIcon() {
        assertEquals(1, AvatarCache.sampleSize(512, 512));
        assertEquals(1, AvatarCache.sampleSize(64, 64));
        assertEquals(2, AvatarCache.sampleSize(1024, 512));
        assertEquals(4, AvatarCache.sampleSize(512, 2048));
        assertEquals("undecodable bounds", 1, AvatarCache.sampleSize(-1, -1));
    }

    @Test
    public void servesACachedAvatarAndTouchesItSoEvictionSeesTheUse() throws IOException {
        File directory = folder.newFolder("hit");
        AvatarCache cache = new AvatarCache(directory);
        byte[] bytes = "vellum".getBytes(StandardCharsets.UTF_8);
        File file = new File(directory, VELLUM_SHA256 + ".png");
        Files.write(file.toPath(), bytes);
        file.setLastModified(1_000_000);

        assertArrayEquals(bytes, cache.verified(VELLUM_SHA256));
        assertTrue("touched", file.lastModified() > 1_000_000);
    }

    @Test
    public void dropsACachedAvatarWhoseBytesNoLongerHashToItsName() throws IOException {
        File directory = folder.newFolder("tampered");
        AvatarCache cache = new AvatarCache(directory);
        File file = new File(directory, VELLUM_SHA256 + ".png");
        Files.write(file.toPath(), "tampered".getBytes(StandardCharsets.UTF_8));

        assertNull(cache.verified(VELLUM_SHA256));
        assertFalse("deleted", file.exists());
    }

    @Test
    public void readsNothingForAnUnusableHashOrAnAbsentFile() throws IOException {
        AvatarCache cache = new AvatarCache(folder.newFolder("empty"));

        assertNull(cache.verified(null));
        assertNull(cache.verified(VELLUM_SHA256));
    }

    /** An over-cap file is never served, so leaving it filed wastes the slot forever. */
    @Test
    public void dropsACachedAvatarBiggerThanTheCap() throws IOException {
        File directory = folder.newFolder("oversized");
        AvatarCache cache = new AvatarCache(directory);
        File file = new File(directory, VELLUM_SHA256 + ".png");
        Files.write(file.toPath(), new byte[512 * 1024 + 1]);

        assertNull(cache.verified(VELLUM_SHA256));
        assertFalse("deleted", file.exists());
    }

    @Test
    public void keepsTheEightNewestAvatarsAndSweepsAbandonedWrites() throws IOException {
        File directory = folder.newFolder("prune");
        long now = System.currentTimeMillis();
        for (int index = 0; index < 10; index++) {
            touched(new File(directory, "avatar-" + index + ".png"), now - index * 1_000L);
        }
        File abandoned = touched(new File(directory, "avatar.1.tmp"), now - 120_000);
        File inFlight = touched(new File(directory, "avatar.2.tmp"), now);

        new AvatarCache(directory).prune();

        List<String> remaining = new ArrayList<>();
        for (File file : directory.listFiles()) {
            remaining.add(file.getName());
        }
        assertEquals(9, remaining.size());
        assertTrue("newest kept", remaining.contains("avatar-0.png"));
        assertTrue("eighth newest kept", remaining.contains("avatar-7.png"));
        assertFalse("ninth newest evicted", remaining.contains("avatar-8.png"));
        assertFalse("oldest evicted", remaining.contains("avatar-9.png"));
        assertFalse("abandoned write swept", abandoned.exists());
        assertTrue("write still in flight kept", inFlight.exists());
    }

    private static File touched(File file, long modified) throws IOException {
        Files.write(file.toPath(), new byte[] { 1 });
        file.setLastModified(modified);
        return file;
    }

    /** A host answering one byte per call, slowly enough to burn the budget. */
    private static TricklingStream tricklingStream(long millisPerRead) {
        return tricklingStream(millisPerRead, Integer.MAX_VALUE);
    }

    private static TricklingStream tricklingStream(long millisPerRead, int bytes) {
        return new TricklingStream(millisPerRead, bytes);
    }

    private static final class TricklingStream extends InputStream {
        private final long millisPerRead;
        private final int limit;
        private int served;

        TricklingStream(long millisPerRead, int limit) {
            this.millisPerRead = millisPerRead;
            this.limit = limit;
        }

        @Override
        public int read() {
            return 0;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            try {
                Thread.sleep(millisPerRead);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new IOException(exception);
            }
            if (served == limit) {
                return -1;
            }
            served++;
            buffer[offset] = 1;
            return 1;
        }
    }
}
