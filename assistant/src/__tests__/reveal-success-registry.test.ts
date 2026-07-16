/**
 * Tests for the reveal-success registry's retention behavior (LUM-2768).
 *
 * The registry is the ground truth the chat-credential persist seams use
 * to prove a reveal ran; losing a record before its tool window closes
 * silently drops the candidate and the printed value persists raw. Recent
 * records must therefore survive the count cap — only the age bound may
 * remove them while a window could still be active.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";

import {
  _recordCountForTest,
  _resetRevealSuccessRegistryForTest,
  closeRevealProofWindow,
  currentRevealSuccessWatermark,
  openRevealProofWindow,
  recordRevealSuccess,
  revealedValueSince,
} from "../runtime/reveal-success-registry.js";

beforeEach(() => {
  _resetRevealSuccessRegistryForTest();
  // Recording is gated on an open proof window (a staged tool reveal);
  // these tests exercise retention semantics, so arm one for the file.
  openRevealProofWindow();
});

afterEach(() => {
  setSystemTime();
});

const TEST_NONCE = "nonce-registry-test";

describe("reveal success registry retention", () => {
  test("recent records survive the count cap while a tool window is active", () => {
    // A single command with hundreds of reveal invocations records every
    // success BEFORE the tool result triggers the proof check. A hard
    // count cap would evict the earliest ones mid-window, so their values
    // could never become candidates.
    const watermark = currentRevealSuccessWatermark();
    for (let i = 0; i < 300; i++) {
      recordRevealSuccess(`service-${i}`, "api_key", `value-${i}`, TEST_NONCE);
    }
    expect(
      revealedValueSince(watermark, "service-0", "api_key", TEST_NONCE),
    ).toBe("value-0");
    expect(
      revealedValueSince(watermark, "service-299", "api_key", TEST_NONCE),
    ).toBe("value-299");
  });

  test("watermark gating still excludes earlier successes", () => {
    recordRevealSuccess("openai", "api_key", "before-watermark", TEST_NONCE);
    const watermark = currentRevealSuccessWatermark();
    expect(
      revealedValueSince(watermark, "openai", "api_key", TEST_NONCE),
    ).toBeUndefined();
    recordRevealSuccess("openai", "api_key", "after-watermark", TEST_NONCE);
    expect(revealedValueSince(watermark, "openai", "api_key", TEST_NONCE)).toBe(
      "after-watermark",
    );
  });

  test("records nothing while no proof window is open", () => {
    // A user's own local CLI reveal outside any assistant tool turn has no
    // pending proof to satisfy — retaining its plaintext for the age bound
    // would expand every CLI reveal's exposure for nothing.
    _resetRevealSuccessRegistryForTest();
    recordRevealSuccess("svc", "f", "hunter2-no-window", TEST_NONCE);
    expect(_recordCountForTest()).toBe(0);
    expect(revealedValueSince(0, "svc", "f", TEST_NONCE)).toBeUndefined();

    // With a window open the same reveal records; closing the last window
    // both stops further recording and drops the retained plaintext.
    const token = openRevealProofWindow();
    recordRevealSuccess("svc", "f", "hunter2-windowed", TEST_NONCE);
    expect(revealedValueSince(0, "svc", "f", TEST_NONCE)).toBe(
      "hunter2-windowed",
    );
    closeRevealProofWindow(token);
    recordRevealSuccess("svc", "f", "hunter2-after-close", TEST_NONCE);
    expect(revealedValueSince(0, "svc", "f", TEST_NONCE)).toBeUndefined();
    expect(_recordCountForTest()).toBe(0);
  });

  test("closing the last proof window drops retained plaintext immediately", () => {
    // Proof consumption reads happen BEFORE a window closes, so once the
    // last window is gone nothing can ever read the records again — they
    // must not sit in memory until the age bound.
    _resetRevealSuccessRegistryForTest();
    const first = openRevealProofWindow();
    const second = openRevealProofWindow();
    recordRevealSuccess("svc", "f", "hunter2-windowed", TEST_NONCE);
    closeRevealProofWindow(first);
    // A concurrent staging (second window) may still consume the record.
    expect(_recordCountForTest()).toBe(1);
    closeRevealProofWindow(second);
    expect(_recordCountForTest()).toBe(0);
  });

  test("an expired record is EVICTED on read, not merely filtered", () => {
    // Records hold credential plaintext. Filtering expired records out of
    // read results while retaining them in memory would keep a lone
    // reveal's secret alive indefinitely — eviction must happen on any
    // registry activity (a write, a read, or the idle timer).
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    recordRevealSuccess("svc", "f", "hunter2-expiring", TEST_NONCE);
    expect(_recordCountForTest()).toBe(1);

    // Past the 6-hour age bound with NO further writes.
    setSystemTime(new Date("2026-01-01T07:00:00Z"));
    expect(revealedValueSince(0, "svc", "f", TEST_NONCE)).toBeUndefined();
    expect(_recordCountForTest()).toBe(0);
  });
});
