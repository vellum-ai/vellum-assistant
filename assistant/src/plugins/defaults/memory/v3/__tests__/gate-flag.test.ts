/**
 * Tests for `gate-flag.ts` — the on/off predicate gating the memory-v3
 * per-turn injection gate. The assistant flag resolver is mocked so the test
 * asserts pure delegation: the predicate forwards `MEMORY_V3_INJECTION_GATE_FLAG`
 * and the config to `isAssistantFeatureFlagEnabled` and returns its boolean.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../../../../config/schema.js";

// The resolver is mocked BEFORE importing the module under test so the import
// observes the spy at load time. The specifier is resolved relative to THIS
// test file (one level deeper than gate-flag.ts's own import path).
const isAssistantFeatureFlagEnabled = mock(
  (_flag: string, _config: AssistantConfig): boolean => false,
);

mock.module("../../../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled,
}));

const { isMemoryV3InjectionGateEnabled, MEMORY_V3_INJECTION_GATE_FLAG } =
  await import("../gate-flag.js");

const cfg = {} as AssistantConfig;

describe("gate-flag", () => {
  beforeEach(() => {
    isAssistantFeatureFlagEnabled.mockReset();
  });

  test("constant is the kebab-case flag id", () => {
    expect(MEMORY_V3_INJECTION_GATE_FLAG).toBe("memory-v3-injection-gate");
  });

  test("delegates to the resolver with the flag id + config and returns true", () => {
    isAssistantFeatureFlagEnabled.mockReturnValue(true);

    expect(isMemoryV3InjectionGateEnabled(cfg)).toBe(true);
    expect(isAssistantFeatureFlagEnabled).toHaveBeenCalledTimes(1);
    expect(isAssistantFeatureFlagEnabled).toHaveBeenCalledWith(
      MEMORY_V3_INJECTION_GATE_FLAG,
      cfg,
    );
  });

  test("returns false when the resolver returns false", () => {
    isAssistantFeatureFlagEnabled.mockReturnValue(false);

    expect(isMemoryV3InjectionGateEnabled(cfg)).toBe(false);
    expect(isAssistantFeatureFlagEnabled).toHaveBeenCalledWith(
      MEMORY_V3_INJECTION_GATE_FLAG,
      cfg,
    );
  });
});
