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
});
