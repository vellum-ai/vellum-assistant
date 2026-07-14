/**
 * Tests for the reveal-success registry's retention behavior (LUM-2768).
 *
 * The registry is the ground truth the chat-credential persist seams use
 * to prove a reveal ran; losing a record before its tool window closes
 * silently drops the candidate and the printed value persists raw. Recent
 * records must therefore survive the count cap — only the age bound may
 * remove them while a window could still be active.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetRevealSuccessRegistryForTest,
  currentRevealSuccessWatermark,
  recordRevealSuccess,
  revealedValueSince,
} from "../runtime/reveal-success-registry.js";

beforeEach(() => {
  _resetRevealSuccessRegistryForTest();
});

describe("reveal success registry retention", () => {
  test("recent records survive the count cap while a tool window is active", () => {
    // A single command with hundreds of reveal invocations records every
    // success BEFORE the tool result triggers the proof check. A hard
    // count cap would evict the earliest ones mid-window, so their values
    // could never become candidates.
    const watermark = currentRevealSuccessWatermark();
    for (let i = 0; i < 300; i++) {
      recordRevealSuccess(`service-${i}`, "api_key", `value-${i}`);
    }
    expect(revealedValueSince(watermark, "service-0", "api_key")).toBe(
      "value-0",
    );
    expect(revealedValueSince(watermark, "service-299", "api_key")).toBe(
      "value-299",
    );
  });

  test("watermark gating still excludes earlier successes", () => {
    recordRevealSuccess("openai", "api_key", "before-watermark");
    const watermark = currentRevealSuccessWatermark();
    expect(revealedValueSince(watermark, "openai", "api_key")).toBeUndefined();
    recordRevealSuccess("openai", "api_key", "after-watermark");
    expect(revealedValueSince(watermark, "openai", "api_key")).toBe(
      "after-watermark",
    );
  });
});
