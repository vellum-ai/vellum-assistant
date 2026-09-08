package ai.vellum.assistant.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class AvatarCacheTest {
    private static final String VELLUM_SHA256 =
        "2fc2a6dd013e7ab41c5a54ab8a254031ff329aa42c5815ac420f1facfe2542d1";

    @Test
    public void readsAPayloadUpToTheCap() throws IOException {
        byte[] bytes = new byte[512 * 1024];
        bytes[bytes.length - 1] = 7;

        byte[] read = AvatarCache.readCapped(new ByteArrayInputStream(bytes));

        assertEquals(bytes.length, read.length);
        assertEquals(7, read[read.length - 1]);
    }

    @Test
    public void rejectsAPayloadOverTheCap() throws IOException {
        byte[] bytes = new byte[512 * 1024 + 1];

        assertNull(AvatarCache.readCapped(new ByteArrayInputStream(bytes)));
    }

    @Test
    public void lowercasesAHashAndRejectsAnythingThatIsNotSha256Hex() {
        assertEquals(VELLUM_SHA256, AvatarCache.normalized(VELLUM_SHA256.toUpperCase()));
        assertNull(AvatarCache.normalized(null));
        assertNull("too short", AvatarCache.normalized(VELLUM_SHA256.substring(1)));
        assertNull("not hex", AvatarCache.normalized(VELLUM_SHA256.replace('0', 'z')));
        assertNull("path traversal", AvatarCache.normalized("../../etc/passwd"));
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
}
