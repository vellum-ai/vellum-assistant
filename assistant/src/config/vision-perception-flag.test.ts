/**
 * Tests for the vision-perception feature gate.
 *
 * Verifies:
 * - isVisionPerceptionEnabled defaults to false (registry default).
 * - It returns true when the flag is enabled via config overrides.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../__tests__/feature-flag-test-helpers.js";
import type { AssistantConfig } from "./schema.js";
import { isVisionPerceptionEnabled } from "./vision-perception-flag.js";

const VISION_PERCEPTION_FLAG = "vision-perception" as const;

beforeEach(() => {
  setOverridesForTesting({});
});

afterEach(() => {
  setOverridesForTesting({});
});

/** Create a minimal AssistantConfig (flag overrides are set via setOverridesForTesting). */
function makeConfig(): AssistantConfig {
  return {} as AssistantConfig;
}

describe("isVisionPerceptionEnabled", () => {
  test("returns false by default (no overrides)", () => {
    expect(isVisionPerceptionEnabled(makeConfig())).toBe(false);
  });

  test("returns true when the flag is enabled", () => {
    setOverridesForTesting({ [VISION_PERCEPTION_FLAG]: true });
    expect(isVisionPerceptionEnabled(makeConfig())).toBe(true);
  });

  test("returns false when explicitly disabled", () => {
    setOverridesForTesting({ [VISION_PERCEPTION_FLAG]: false });
    expect(isVisionPerceptionEnabled(makeConfig())).toBe(false);
  });
});
