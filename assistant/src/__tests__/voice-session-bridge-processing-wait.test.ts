import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before importing voice-session-bridge so its module-level
// imports (logger, config loader) stay side-effect free for this pure helper.
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
}));

import { resolveProcessingWaitMs } from "../calls/voice-session-bridge.js";

describe("resolveProcessingWaitMs", () => {
  test("sums commit window, abort unwind budget, and fixed margin", () => {
    expect(resolveProcessingWaitMs(4000, 5000)).toBe(10000);
    expect(resolveProcessingWaitMs(1000, 5000)).toBe(7000);
    expect(resolveProcessingWaitMs(4000, 0)).toBe(5000);
  });
});
