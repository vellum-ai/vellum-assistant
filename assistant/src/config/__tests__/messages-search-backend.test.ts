import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

afterAll(() => {
  mock.restore();
});

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { getMessagesSearchBackend } from "../assistant-feature-flags.js";
import type { AssistantConfig } from "../schema.js";

// The resolver reads the flag from the override cache + registry; it does not
// consult the passed config, so a minimal stub is sufficient.
const CONFIG = {} as AssistantConfig;

describe("getMessagesSearchBackend", () => {
  afterEach(() => {
    setOverridesForTesting({});
  });

  // Each case seeds the override cache so the value flows through the real
  // `getAssistantFeatureFlagValue` plumbing — the path that can deliver this
  // flag as a string. Only boolean `true` or the exact string `"qdrant"`
  // selects qdrant; everything else must fall back to the safe fts5 default.

  test("defaults to fts5 when the flag is unset", () => {
    setOverridesForTesting({});
    expect(getMessagesSearchBackend(CONFIG)).toBe("fts5");
  });

  test("returns qdrant when the flag is boolean true", () => {
    setOverridesForTesting({ "messages-search-backend": true });
    expect(getMessagesSearchBackend(CONFIG)).toBe("qdrant");
  });

  test('returns qdrant when the flag is the string "qdrant"', () => {
    setOverridesForTesting({ "messages-search-backend": "qdrant" });
    expect(getMessagesSearchBackend(CONFIG)).toBe("qdrant");
  });

  test("returns fts5 when the flag is boolean false", () => {
    setOverridesForTesting({ "messages-search-backend": false });
    expect(getMessagesSearchBackend(CONFIG)).toBe("fts5");
  });

  test('returns fts5 when the flag is the string "fts5"', () => {
    setOverridesForTesting({ "messages-search-backend": "fts5" });
    expect(getMessagesSearchBackend(CONFIG)).toBe("fts5");
  });

  test("returns fts5 for an unexpected non-empty string", () => {
    setOverridesForTesting({ "messages-search-backend": "bogus" });
    expect(getMessagesSearchBackend(CONFIG)).toBe("fts5");
  });
});
