/**
 * Integration tests for assistant feature flag resolver.
 *
 * Covers:
 *   - Missing persisted value falls back to code default
 *   - Protected feature-flags.json is the sole override mechanism
 *   - Undeclared keys default to disabled
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test-scoped config state
// ---------------------------------------------------------------------------

const DECLARED_FLAG_ID = "a2a-channel";
const DECLARED_FLAG_KEY = DECLARED_FLAG_ID;

const { isAssistantFeatureFlagEnabled } =
  await import("../config/assistant-feature-flags.js");
const { setOverridesForTesting } =
  await import("./feature-flag-test-helpers.js");
const { skillFlagKey } = await import("../config/skill-state.js");

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  setOverridesForTesting({});
});

afterEach(() => {
  setOverridesForTesting({});
});

// ---------------------------------------------------------------------------
// Resolver unit tests (within integration context)
// ---------------------------------------------------------------------------

describe("isAssistantFeatureFlagEnabled", () => {
  test("reads from file-based overrides", () => {
    setOverridesForTesting({ [DECLARED_FLAG_KEY]: true });
    const config = {} as any;

    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(true);
  });

  test("explicit false override in file-based overrides", () => {
    setOverridesForTesting({ [DECLARED_FLAG_KEY]: false });
    const config = {} as any;

    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(
      false,
    );
  });

  test("missing persisted value falls back to defaults registry defaultEnabled", () => {
    // No explicit config at all — should fall back to defaults registry
    // which has defaultEnabled: false for a2a-channel
    const config = {} as any;

    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(
      false,
    );
  });

  test("unknown flag defaults to false when no persisted override", () => {
    const config = {} as any;

    expect(isAssistantFeatureFlagEnabled("unknown-skill", config)).toBe(false);
  });

  test("undeclared flag respects persisted override", () => {
    setOverridesForTesting({ "some-undeclared-flag": false });
    const config = {} as any;

    expect(isAssistantFeatureFlagEnabled("some-undeclared-flag", config)).toBe(
      false,
    );
  });
});

describe("isAssistantFeatureFlagEnabled with skillFlagKey", () => {
  test("resolves skill flag via canonical path", () => {
    setOverridesForTesting({ [DECLARED_FLAG_KEY]: false });
    const config = {} as any;

    expect(
      isAssistantFeatureFlagEnabled(
        skillFlagKey({ featureFlag: DECLARED_FLAG_ID })!,
        config,
      ),
    ).toBe(false);
  });

  test("disabled when no override set (registry default is false)", () => {
    const config = {} as any;

    expect(
      isAssistantFeatureFlagEnabled(
        skillFlagKey({ featureFlag: DECLARED_FLAG_ID })!,
        config,
      ),
    ).toBe(false);
  });
});
