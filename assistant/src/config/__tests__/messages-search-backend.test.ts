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
import {
  clearFeatureFlagOverridesCache,
  getMessagesSearchBackend,
} from "../assistant-feature-flags.js";
import type { AssistantConfig } from "../schema.js";

// The resolver reads the flag from the override cache + registry; it does not
// consult the passed config, so a minimal stub is sufficient.
const CONFIG = {} as AssistantConfig;

describe("getMessagesSearchBackend", () => {
  afterEach(() => {
    setOverridesForTesting({});
  });

  // Each case seeds the override cache so the value flows through the real
  // `getAssistantFeatureFlagValue` plumbing. The flag is boolean and defaults
  // to enabled in the registry, so an unset flag resolves to the registry
  // default (qdrant); an explicit `false` override selects fts5. The string
  // cases are defensive: the override plumbing is typed `boolean | string`, so
  // a stray string could still arrive — only the exact `"qdrant"` selects
  // qdrant; every other value falls back to the safe fts5 fallback.

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

describe("getMessagesSearchBackend · managed staged-rollout guard", () => {
  const savedIsPlatform = process.env.IS_PLATFORM;

  afterEach(() => {
    if (savedIsPlatform === undefined) {
      delete process.env.IS_PLATFORM;
    } else {
      process.env.IS_PLATFORM = savedIsPlatform;
    }
    setOverridesForTesting({});
  });

  // On a managed instance the cutover is gated on LaunchDarkly targeting,
  // delivered through the gateway override map. The daemon selects qdrant only
  // from an explicit gateway-supplied value — never its own registry default —
  // so it fails safe to fts5 whenever no such value is present: the cache is not
  // yet gateway-populated (startup race / IPC failure), or the hydrated map
  // omits the key (a split/older gateway, or an unsynced gateway registry).

  test("fails safe to fts5 on managed when the gateway cache has not hydrated", () => {
    process.env.IS_PLATFORM = "true";
    // Cache not populated from the gateway (the pre-hydration / IPC-failure
    // window). No explicit gateway value ⇒ fts5.
    clearFeatureFlagOverridesCache();
    expect(getMessagesSearchBackend(CONFIG)).toBe("fts5");
  });

  test("fails safe to fts5 on managed when the hydrated gateway map omits the key", () => {
    process.env.IS_PLATFORM = "true";
    // Gateway map is populated (isCachedFromGateway() true) but does not carry
    // messages-search-backend — e.g. a split/older gateway or unsynced gateway
    // registry. The daemon must NOT fall through to its own registry default
    // (qdrant); with no explicit gateway value it stays on fts5.
    setOverridesForTesting({ "some-other-flag": true });
    expect(getMessagesSearchBackend(CONFIG)).toBe("fts5");
  });

  test("trusts the gateway value on managed once the cache has hydrated", () => {
    process.env.IS_PLATFORM = "true";
    // Gateway map hydrated with an explicit qdrant (LD targeted the flag on).
    setOverridesForTesting({ "messages-search-backend": true });
    expect(getMessagesSearchBackend(CONFIG)).toBe("qdrant");
  });

  test("honors the gateway fail-safe false on managed once hydrated", () => {
    process.env.IS_PLATFORM = "true";
    // Gateway resolved the absent flag to false (managed fail-safe) and pushed
    // it into the cache.
    setOverridesForTesting({ "messages-search-backend": false });
    expect(getMessagesSearchBackend(CONFIG)).toBe("fts5");
  });

  test("uses the qdrant registry default on non-managed even before hydration", () => {
    // Local/self-hosted (IS_PLATFORM unset): the guard must not fire, so an
    // unhydrated cache still yields the qdrant registry default.
    delete process.env.IS_PLATFORM;
    clearFeatureFlagOverridesCache();
    expect(getMessagesSearchBackend(CONFIG)).toBe("qdrant");
  });
});
