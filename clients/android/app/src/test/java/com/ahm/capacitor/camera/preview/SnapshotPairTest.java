package com.ahm.capacitor.camera.preview;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SnapshotPairTest {
    private static long ms(long value) {
        return value * 1_000_000L;
    }

    @Test
    public void copiesTwoBuffersWithTheRequestedSpacingAndMonotonicOffsets() {
        SnapshotPair pair = new SnapshotPair(60, ms(100));
        byte[] reused = { 1, 2 };
        assertNull(pair.capture(reused, ms(110)));
        reused[0] = 3;
        assertNull(pair.capture(reused, ms(143)));
        reused[0] = 4;
        SnapshotPair.Frames frames = pair.capture(reused, ms(176));
        assertNotNull(frames);
        reused[0] = 5;
        assertArrayEquals(new byte[] { 1, 2 }, frames.first);
        assertArrayEquals(new byte[] { 4, 2 }, frames.second);
        assertEquals(10.0, frames.firstCapturedAfterMs, 0);
        assertEquals(76.0, frames.secondCapturedAfterMs, 0);
        assertNull(pair.capture(reused, ms(210)));
    }

    @Test
    public void recordsCaptureTimesIndependentlyOfLaterEncoding() {
        SnapshotPair pair = new SnapshotPair(60, ms(100));
        assertNull(pair.capture(new byte[] { 1 }, ms(120)));
        SnapshotPair.Frames frames = pair.capture(new byte[] { 2 }, ms(186));
        assertFalse(pair.expired(ms(1100)));
        assertTrue(pair.complete());
        assertEquals(66.0, frames.secondCapturedAfterMs - frames.firstCapturedAfterMs, 0);
    }

    @Test
    public void cancellationDropsAPartialPairAndRejectsLateFrames() {
        SnapshotPair pair = new SnapshotPair(60, ms(100));
        pair.capture(new byte[] { 1 }, ms(110));
        assertTrue(pair.complete());
        assertTrue(pair.isCompleted());
        assertNull(pair.capture(new byte[] { 2 }, ms(180)));
        assertFalse(pair.complete());
    }

    @Test
    public void cancellationWhileEncodingWinsExactlyOnceAndDoesNotAffectTheReplacement() {
        SnapshotPair retired = new SnapshotPair(60, ms(100));
        retired.capture(new byte[] { 1 }, ms(110));
        assertNotNull(retired.capture(new byte[] { 2 }, ms(180)));
        SnapshotPair replacement = new SnapshotPair(60, ms(200));
        assertTrue(retired.complete());
        assertFalse(retired.complete());
        replacement.capture(new byte[] { 3 }, ms(210));
        assertNotNull(replacement.capture(new byte[] { 4 }, ms(280)));
        assertTrue(replacement.complete());
    }

    @Test
    public void timeoutIncludesQueueDelayAndRefusesLateFrames() {
        SnapshotPair pair = new SnapshotPair(60, ms(100));
        assertEquals(4000, pair.remainingMs(ms(1100)));
        assertFalse(pair.expired(ms(5099)));
        assertTrue(pair.expired(ms(5100)));
        assertEquals(0, pair.remainingMs(ms(6100)));
        assertNull(pair.capture(new byte[] { 1 }, ms(5100)));
        assertTrue(pair.complete());
        assertFalse(pair.complete());
    }

    @Test
    public void slowPreviewPairsRetainTheirTrueGapForTheWebGateToReject() {
        SnapshotPair pair = new SnapshotPair(60, ms(100));
        pair.capture(new byte[] { 1 }, ms(110));
        SnapshotPair.Frames frames = pair.capture(new byte[] { 2 }, ms(280));
        assertNotNull(frames);
        assertEquals(170.0, frames.secondCapturedAfterMs - frames.firstCapturedAfterMs, 0);
    }

    @Test
    public void absentOrPreRequestFramesCannotPrimeAPair() {
        SnapshotPair pair = new SnapshotPair(60, ms(100));
        assertNull(pair.capture(null, ms(110)));
        assertNull(pair.capture(new byte[] { 1 }, ms(90)));
        assertNull(pair.capture(new byte[] { 2 }, ms(160)));
        SnapshotPair.Frames frames = pair.capture(new byte[] { 3 }, ms(220));
        assertNotNull(frames);
        assertEquals(60.0, frames.firstCapturedAfterMs, 0);
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsZeroSpacing() {
        new SnapshotPair(0, 0);
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsSpacingBeyondTheMotionWindow() {
        new SnapshotPair(121, 0);
    }
}
