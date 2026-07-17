import { describe, expect, test } from "bun:test";

import { resolveProcessingWaitMs } from "../calls/voice-session-bridge.js";

describe("resolveProcessingWaitMs", () => {
  test("sums commit window, abort unwind budget, and fixed margin", () => {
    expect(resolveProcessingWaitMs(4000, 5000)).toBe(10000);
    expect(resolveProcessingWaitMs(1000, 5000)).toBe(7000);
    expect(resolveProcessingWaitMs(4000, 0)).toBe(5000);
  });
});
