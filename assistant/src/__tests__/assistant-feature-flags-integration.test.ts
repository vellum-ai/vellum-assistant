/**
 * Integration tests for assistant feature flag resolver.
 *
 * Covers:
 *   - Missing persisted value falls back to code default
 *   - Protected feature-flags.json is the sole override mechanism
 *   - Undeclared keys default to enabled
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test-scoped config state
// ---------------------------------------------------------------------------

const DECLARED_FLAG_ID = "sounds";
const DECLARED_FLAG_KEY = DECLARED_FLAG_ID;

const { isAssistantFeatureFlagEnabled, _setOverridesForTesting } =
  await import("../config/assistant-feature-flags.js");
const { skillFlagKey } = await import("../config/skill-state.js");

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _setOverridesForTesting({});
});

afterEach(() => {
  _setOverridesForTesting({});
});

// ---------------------------------------------------------------------------
// Resolver unit tests (within integration context)
// ---------------------------------------------------------------------------

describe("isAssistantFeatureFlagEnabled", () => {
  test("reads from file-based overrides", () => {
    _setOverridesForTesting({ [DECLARED_FLAG_KEY]: true });
    const config = {} as any;

    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(true);
  });

  test("explicit false override in file-based overrides", () => {
    _setOverridesForTesting({ [DECLARED_FLAG_KEY]: false });
    const config = {} as any;

    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(
      false,
    );
  });

  test("missing persisted value falls back to defaults registry defaultEnabled", () => {
    // No explicit config at all — should fall back to defaults registry
    // which has defaultEnabled: true for sounds
    const config = {} as any;

    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(true);
  });

  test("unknown flag defaults to true when no persisted override", () => {
    const config = {} as any;

    expect(isAssistantFeatureFlagEnabled("unknown-skill", config)).toBe(true);
  });

  test("undeclared flag respects persisted override", () => {
    _setOverridesForTesting({ browser: false });
    const config = {} as any;

    expect(isAssistantFeatureFlagEnabled("browser", config)).toBe(false);
  });
});

describe("isAssistantFeatureFlagEnabled with skillFlagKey", () => {
  test("resolves skill flag via canonical path", () => {
    _setOverridesForTesting({ [DECLARED_FLAG_KEY]: false });
    const config = {} as any;

    expect(
      isAssistantFeatureFlagEnabled(
        skillFlagKey({ featureFlag: DECLARED_FLAG_ID })!,
        config,
      ),
    ).toBe(false);
  });

  test("enabled when no override set (registry default is true)", () => {
    const config = {} as any;

    expect(
      isAssistantFeatureFlagEnabled(
        skillFlagKey({ featureFlag: DECLARED_FLAG_ID })!,
        config,
      ),
    ).toBe(true);
  });
});
