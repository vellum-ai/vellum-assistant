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
  test("covers the default commit window plus abort unwind budget", () => {
    expect(resolveProcessingWaitMs(4000, 5000)).toBe(10000);
  });

  test("adds the fixed margin to commit window plus abort budget", () => {
    expect(resolveProcessingWaitMs(1000, 5000)).toBe(7000);
    expect(resolveProcessingWaitMs(4000, 0)).toBe(5000);
  });
});
