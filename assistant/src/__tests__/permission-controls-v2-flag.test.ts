/**
 * Tests for the `permission-controls-v2` feature flag.
 *
 * Verifies:
 *   - The flag defaults to disabled (not enabled)
 *   - The flag can be enabled via `_setOverridesForTesting`
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _setOverridesForTesting,
  isAssistantFeatureFlagEnabled,
} from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): AssistantConfig {
  return {} as AssistantConfig;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _setOverridesForTesting({});
});

afterEach(() => {
  _setOverridesForTesting({});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("permission-controls-v2 feature flag", () => {
  test("defaults to disabled", () => {
    const config = makeConfig();
    expect(
      isAssistantFeatureFlagEnabled("permission-controls-v2", config),
    ).toBe(false);
  });

  test("can be enabled via overrides", () => {
    _setOverridesForTesting({ "permission-controls-v2": true });
    const config = makeConfig();
    expect(
      isAssistantFeatureFlagEnabled("permission-controls-v2", config),
    ).toBe(true);
  });
});
