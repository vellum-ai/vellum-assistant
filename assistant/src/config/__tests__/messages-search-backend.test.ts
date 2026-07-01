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
  // `getAssistantFeatureFlagValue` plumbing. The flag is boolean, so enabled
  // (`true`) selects qdrant and disabled (`false`) selects fts5. When no
  // override is present the resolver falls through to the registry
  // `defaultEnabled`, which is `true` ⇒ qdrant. The string cases are
  // defensive: the override plumbing is typed `boolean | string`, so a stray
  // string could still arrive — only the exact `"qdrant"` selects qdrant;
  // every other string falls back to the safe fts5 fallback.

  test("defaults to qdrant when the flag is unset (registry default)", () => {
    setOverridesForTesting({});
    expect(getMessagesSearchBackend(CONFIG)).toBe("qdrant");
  });

  test("returns qdrant when the flag is enabled (boolean true)", () => {
    setOverridesForTesting({ "messages-search-backend": true });
    expect(getMessagesSearchBackend(CONFIG)).toBe("qdrant");
  });

  test("returns fts5 when the flag is disabled (boolean false)", () => {
    setOverridesForTesting({ "messages-search-backend": false });
    expect(getMessagesSearchBackend(CONFIG)).toBe("fts5");
  });

  test('defensively selects qdrant for a stray string "qdrant" override', () => {
    setOverridesForTesting({ "messages-search-backend": "qdrant" });
    expect(getMessagesSearchBackend(CONFIG)).toBe("qdrant");
  });

  test('defensively falls back to fts5 for a stray string "fts5" override', () => {
    setOverridesForTesting({ "messages-search-backend": "fts5" });
    expect(getMessagesSearchBackend(CONFIG)).toBe("fts5");
  });

  test("defensively falls back to fts5 for an unexpected non-empty string", () => {
    setOverridesForTesting({ "messages-search-backend": "bogus" });
    expect(getMessagesSearchBackend(CONFIG)).toBe("fts5");
  });
});
