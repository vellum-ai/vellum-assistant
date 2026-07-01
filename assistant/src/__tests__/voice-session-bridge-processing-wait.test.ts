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
  test("adds a fixed margin to the default commit window", () => {
    expect(resolveProcessingWaitMs(4000)).toBe(5000);
    expect(resolveProcessingWaitMs(4000)).toBeGreaterThan(4000);
  });

  test("always returns strictly greater than the commit window", () => {
    for (const n of [1, 100, 4000, 10000]) {
      expect(resolveProcessingWaitMs(n)).toBeGreaterThan(n);
    }
  });
});
