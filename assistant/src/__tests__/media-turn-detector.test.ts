import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import { MediaTurnDetector } from "../calls/media-turn-detector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Advance fake timers by `ms` milliseconds. Uses Bun's `jest.advanceTimersByTime`.
 */
function advance(ms: number): void {
  jest.advanceTimersByTime(ms);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MediaTurnDetector", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Basic lifecycle ──────────────────────────────────────────────

  test("starts inactive", () => {
    const detector = new MediaTurnDetector();
    expect(detector.isActive).toBe(false);
    detector.dispose();
  });

  test("transitions to active on first chunk", () => {
    const detector = new MediaTurnDetector();
    detector.onMediaChunk();
    expect(detector.isActive).toBe(true);
    detector.dispose();
  });

  // ── Silence detection ────────────────────────────────────────────

  test("fires onTurnEnd with 'silence' after silence threshold", () => {
    const onTurnStart = jest.fn();
    const onTurnEnd = jest.fn();

    const detector = new MediaTurnDetector(
      { silenceThresholdMs: 500 },
      { onTurnStart, onTurnEnd },
    );

    detector.onMediaChunk();
    expect(onTurnStart).toHaveBeenCalledTimes(1);
    expect(detector.isActive).toBe(true);

    // Advance past the silence threshold
    advance(600);

    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledWith("silence", expect.any(Number));
    expect(detector.isActive).toBe(false);

    detector.dispose();
  });

  test("resets silence timer on subsequent chunks", () => {
    const onTurnEnd = jest.fn();

    const detector = new MediaTurnDetector(
      { silenceThresholdMs: 500 },
      { onTurnEnd },
    );

    detector.onMediaChunk();

    // 300ms in — silence timer has NOT fired yet
    advance(300);
    expect(onTurnEnd).not.toHaveBeenCalled();

    // New chunk resets the 500ms silence timer
    detector.onMediaChunk();

    // Another 300ms — still within the reset window
    advance(300);
    expect(onTurnEnd).not.toHaveBeenCalled();

    // 250ms more (550ms since last chunk) — past threshold
    advance(250);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledWith("silence", expect.any(Number));

    detector.dispose();
  });

  // ── Max duration ─────────────────────────────────────────────────

  test("fires onTurnEnd with 'max-duration' when hard cap is reached", () => {
    const onTurnEnd = jest.fn();

    const detector = new MediaTurnDetector(
      { silenceThresholdMs: 500, maxTurnDurationMs: 2000 },
      { onTurnEnd },
    );

    detector.onMediaChunk();

    // Keep feeding chunks so the silence timer never fires
    for (let i = 0; i < 8; i++) {
      advance(200);
      detector.onMediaChunk();
    }

    // At 1600ms, still active. Advance to 2000ms.
    advance(400);

    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledWith("max-duration", expect.any(Number));
    expect(detector.isActive).toBe(false);

    detector.dispose();
  });

  // ── Turn restart ─────────────────────────────────────────────────

  test("can start a new turn after silence ends the previous one", () => {
    const onTurnStart = jest.fn();
    const onTurnEnd = jest.fn();

    const detector = new MediaTurnDetector(
      { silenceThresholdMs: 500 },
      { onTurnStart, onTurnEnd },
    );

    // First turn
    detector.onMediaChunk();
    expect(onTurnStart).toHaveBeenCalledTimes(1);
    advance(600);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(detector.isActive).toBe(false);

    // Second turn
    detector.onMediaChunk();
    expect(onTurnStart).toHaveBeenCalledTimes(2);
    expect(detector.isActive).toBe(true);

    advance(600);
    expect(onTurnEnd).toHaveBeenCalledTimes(2);

    detector.dispose();
  });

  // ── forceEnd ─────────────────────────────────────────────────────

  test("forceEnd ends the current turn immediately", () => {
    const onTurnEnd = jest.fn();

    const detector = new MediaTurnDetector(
      { silenceThresholdMs: 500 },
      { onTurnEnd },
    );

    detector.onMediaChunk();
    expect(detector.isActive).toBe(true);

    detector.forceEnd();
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledWith("silence", expect.any(Number));
    expect(detector.isActive).toBe(false);

    detector.dispose();
  });

  test("forceEnd is a no-op when inactive", () => {
    const onTurnEnd = jest.fn();

    const detector = new MediaTurnDetector(
      { silenceThresholdMs: 500 },
      { onTurnEnd },
    );

    detector.forceEnd();
    expect(onTurnEnd).not.toHaveBeenCalled();
    expect(detector.isActive).toBe(false);

    detector.dispose();
  });

  // ── dispose ──────────────────────────────────────────────────────

  test("dispose prevents further callbacks", () => {
    const onTurnStart = jest.fn();
    const onTurnEnd = jest.fn();

    const detector = new MediaTurnDetector(
      { silenceThresholdMs: 500 },
      { onTurnStart, onTurnEnd },
    );

    detector.onMediaChunk();
    expect(onTurnStart).toHaveBeenCalledTimes(1);

    detector.dispose();

    // Silence timer should have been cleared — advancing should not
    // trigger onTurnEnd.
    advance(1000);
    expect(onTurnEnd).not.toHaveBeenCalled();

    // Further chunks should be ignored.
    detector.onMediaChunk();
    expect(onTurnStart).toHaveBeenCalledTimes(1);
  });

  test("dispose + forceEnd is a no-op", () => {
    const onTurnEnd = jest.fn();

    const detector = new MediaTurnDetector(
      { silenceThresholdMs: 500 },
      { onTurnEnd },
    );

    detector.onMediaChunk();
    detector.dispose();
    detector.forceEnd();
    expect(onTurnEnd).not.toHaveBeenCalled();
  });

  // ── Default config ───────────────────────────────────────────────

  test("uses default thresholds when config is omitted", () => {
    const onTurnEnd = jest.fn();
    const detector = new MediaTurnDetector({}, { onTurnEnd });

    detector.onMediaChunk();

    // Default silence threshold is 800ms
    advance(700);
    expect(onTurnEnd).not.toHaveBeenCalled();
    advance(200);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);

    detector.dispose();
  });

  // ── onTurnStart only fires once per turn ─────────────────────────

  test("onTurnStart fires only once even with many chunks", () => {
    const onTurnStart = jest.fn();
    const detector = new MediaTurnDetector(
      { silenceThresholdMs: 500 },
      { onTurnStart },
    );

    detector.onMediaChunk();
    detector.onMediaChunk();
    detector.onMediaChunk();
    detector.onMediaChunk();

    expect(onTurnStart).toHaveBeenCalledTimes(1);

    detector.dispose();
  });

  // ── Speech-aware segmentation ─────────────────────────────────────

  describe("speech-aware segmentation", () => {
    test("continuous chunk flow with speech->silence transition ends the turn", () => {
      const onTurnStart = jest.fn();
      const onTurnEnd = jest.fn();

      const detector = new MediaTurnDetector(
        { silenceThresholdMs: 500 },
        { onTurnStart, onTurnEnd },
      );

      // Speech chunks — resets silence timer on each
      detector.onMediaChunk(true);
      expect(onTurnStart).toHaveBeenCalledTimes(1);

      advance(100);
      detector.onMediaChunk(true);
      advance(100);
      detector.onMediaChunk(true);

      // Transition to silence — continuous silent chunks should NOT
      // reset the silence timer, so the turn ends after the threshold.
      advance(100);
      detector.onMediaChunk(false);
      advance(100);
      detector.onMediaChunk(false);
      advance(100);
      detector.onMediaChunk(false);

      // Not yet past threshold from last speech chunk (300ms of silence
      // plus whatever the timer started at when silence began)
      expect(onTurnEnd).not.toHaveBeenCalled();

      // Advance past the silence threshold from the last speech chunk
      advance(500);

      expect(onTurnEnd).toHaveBeenCalledTimes(1);
      expect(onTurnEnd).toHaveBeenCalledWith("silence", expect.any(Number));
      expect(detector.isActive).toBe(false);

      detector.dispose();
    });

    test("no-speech continuous noise/silence does not start a turn", () => {
      const onTurnStart = jest.fn();
      const onTurnEnd = jest.fn();

      const detector = new MediaTurnDetector(
        { silenceThresholdMs: 500 },
        { onTurnStart, onTurnEnd },
      );

      // Send many chunks with no speech — turn should never start
      for (let i = 0; i < 20; i++) {
        detector.onMediaChunk(false);
        advance(50);
      }

      expect(onTurnStart).not.toHaveBeenCalled();
      expect(onTurnEnd).not.toHaveBeenCalled();
      expect(detector.isActive).toBe(false);

      detector.dispose();
    });

    test("max-duration fallback still fires with continuous speech", () => {
      const onTurnEnd = jest.fn();

      const detector = new MediaTurnDetector(
        { silenceThresholdMs: 500, maxTurnDurationMs: 2000 },
        { onTurnEnd },
      );

      // Continuous speech chunks — silence timer keeps resetting
      detector.onMediaChunk(true);
      for (let i = 0; i < 10; i++) {
        advance(180);
        detector.onMediaChunk(true);
      }

      // At ~1800ms. Advance to 2000ms to hit max-duration.
      advance(200);

      expect(onTurnEnd).toHaveBeenCalledTimes(1);
      expect(onTurnEnd).toHaveBeenCalledWith(
        "max-duration",
        expect.any(Number),
      );
      expect(detector.isActive).toBe(false);

      detector.dispose();
    });

    test("silent chunks during active turn do not reset the silence timer", () => {
      const onTurnEnd = jest.fn();

      const detector = new MediaTurnDetector(
        { silenceThresholdMs: 500 },
        { onTurnEnd },
      );

      // Start with speech
      detector.onMediaChunk(true);

      // Advance 200ms, then send silent chunks — they should NOT
      // extend the turn by resetting the timer.
      advance(200);
      detector.onMediaChunk(false);
      advance(100);
      detector.onMediaChunk(false);
      advance(100);
      detector.onMediaChunk(false);

      // Silence timer started from the last speech chunk. At 500ms
      // from that point, the turn should end.
      advance(200); // 200+100+100+200 = 600ms since last speech

      expect(onTurnEnd).toHaveBeenCalledTimes(1);
      expect(onTurnEnd).toHaveBeenCalledWith("silence", expect.any(Number));

      detector.dispose();
    });

    test("speech resuming during silence countdown resets the timer", () => {
      const onTurnEnd = jest.fn();

      const detector = new MediaTurnDetector(
        { silenceThresholdMs: 500 },
        { onTurnEnd },
      );

      // Speech starts
      detector.onMediaChunk(true);

      // 300ms of silence
      advance(300);
      detector.onMediaChunk(false);

      // Speech resumes — resets silence timer
      advance(100);
      detector.onMediaChunk(true);

      // Timer reset: another 500ms must pass
      advance(400);
      expect(onTurnEnd).not.toHaveBeenCalled();

      advance(200);
      expect(onTurnEnd).toHaveBeenCalledTimes(1);

      detector.dispose();
    });

    test("backwards compatibility: onMediaChunk without hasSpeech argument defaults to true", () => {
      const onTurnStart = jest.fn();
      const onTurnEnd = jest.fn();

      const detector = new MediaTurnDetector(
        { silenceThresholdMs: 500 },
        { onTurnStart, onTurnEnd },
      );

      // Call without argument — defaults to hasSpeech=true
      detector.onMediaChunk();
      expect(onTurnStart).toHaveBeenCalledTimes(1);
      expect(detector.isActive).toBe(true);

      advance(600);
      expect(onTurnEnd).toHaveBeenCalledTimes(1);

      detector.dispose();
    });
  });
});
