import { afterEach, describe, expect, test } from "bun:test";

import {
  clearFeatureFlagOverridesCache,
  isVoiceFrontModelEnabled,
  VOICE_FRONT_MODEL_FLAG,
} from "../assistant-feature-flags.js";
import { setCachedOverrides } from "../feature-flag-cache.js";
import type { AssistantConfig } from "../schema.js";

// The gate ignores the config arg (flags resolve from the override cache +
// bundled registry), so a bare cast is sufficient.
const CONFIG = {} as AssistantConfig;

afterEach(() => {
  clearFeatureFlagOverridesCache();
});

describe("isVoiceFrontModelEnabled", () => {
  test("is off by default (registry defaultEnabled: false)", () => {
    clearFeatureFlagOverridesCache();
    expect(isVoiceFrontModelEnabled(CONFIG)).toBe(false);
  });

  test("is on when the flag override is set", () => {
    setCachedOverrides(
      { [VOICE_FRONT_MODEL_FLAG]: true },
      { fromGateway: true },
    );
    expect(isVoiceFrontModelEnabled(CONFIG)).toBe(true);
  });

  test("is off when the flag override is explicitly false", () => {
    setCachedOverrides(
      { [VOICE_FRONT_MODEL_FLAG]: false },
      { fromGateway: true },
    );
    expect(isVoiceFrontModelEnabled(CONFIG)).toBe(false);
  });
});
