import { describe, expect, test } from "bun:test";

import { memoryTier } from "./memory-tier.js";
import {
  isMemoryEnabled,
  isMemoryV1Active,
  isMemoryV2ExplicitlyDisabled,
  isV2InjectionEngineActive,
  usesConceptPageMemory,
} from "./memory-v3-gate.js";
import type { AssistantConfig } from "./schema.js";

describe("usesConceptPageMemory", () => {
  test("false when memory is explicitly disabled, even with v3 live", () => {
    expect(usesConceptPageMemory({ enabled: false, v3: { live: true } })).toBe(
      false,
    );
    expect(
      usesConceptPageMemory({ enabled: false, v2: { enabled: true } }),
    ).toBe(false);
  });

  test("true when v3 is live, regardless of the v2 flag", () => {
    expect(usesConceptPageMemory({ v3: { live: true } })).toBe(true);
    expect(
      usesConceptPageMemory({ v2: { enabled: false }, v3: { live: true } }),
    ).toBe(true);
  });

  test("true when the v2 injection engine is enabled", () => {
    expect(usesConceptPageMemory({ v2: { enabled: true } })).toBe(true);
  });

  test("false when neither v3 nor v2 is on (tier v1)", () => {
    expect(
      usesConceptPageMemory({
        enabled: true,
        v2: { enabled: false },
        v3: { live: false },
      }),
    ).toBe(false);
  });

  test("false on missing config (defensive optional chaining)", () => {
    expect(usesConceptPageMemory(undefined)).toBe(false);
    expect(usesConceptPageMemory({})).toBe(false);
  });
});

type TriState = boolean | undefined;

function makeConfig(
  enabled: TriState,
  v2Enabled: TriState,
  v3Live: TriState,
): AssistantConfig {
  return {
    memory: {
      ...(enabled === undefined ? {} : { enabled }),
      ...(v2Enabled === undefined ? {} : { v2: { enabled: v2Enabled } }),
      ...(v3Live === undefined ? {} : { v3: { live: v3Live } }),
    },
  } as AssistantConfig;
}

describe("tier predicate truth table", () => {
  // Rows: [enabled, v2.enabled, v3.live] → expected
  // [isMemoryEnabled, isMemoryV1Active, isV2InjectionEngineActive, isMemoryV2ExplicitlyDisabled].
  // undefined = key unset. Covers all 27 {enabled, v2.enabled, v3.live}
  // tri-state combinations.
  const rows: Array<{
    inputs: [TriState, TriState, TriState];
    expected: [boolean, boolean, boolean, boolean];
  }> = [
    // memory on by default (enabled unset)
    {
      inputs: [undefined, undefined, undefined],
      expected: [true, true, false, false],
    },
    {
      inputs: [undefined, undefined, true],
      expected: [true, false, false, false],
    },
    {
      inputs: [undefined, undefined, false],
      expected: [true, true, false, false],
    },
    {
      inputs: [undefined, true, undefined],
      expected: [true, false, true, false],
    },
    { inputs: [undefined, true, true], expected: [true, false, false, false] },
    { inputs: [undefined, true, false], expected: [true, false, true, false] },
    {
      inputs: [undefined, false, undefined],
      expected: [true, true, false, true],
    },
    { inputs: [undefined, false, true], expected: [true, false, false, true] },
    { inputs: [undefined, false, false], expected: [true, true, false, true] },
    // memory explicitly on
    {
      inputs: [true, undefined, undefined],
      expected: [true, true, false, false],
    },
    { inputs: [true, undefined, true], expected: [true, false, false, false] },
    { inputs: [true, undefined, false], expected: [true, true, false, false] },
    { inputs: [true, true, undefined], expected: [true, false, true, false] },
    { inputs: [true, true, true], expected: [true, false, false, false] },
    { inputs: [true, true, false], expected: [true, false, true, false] },
    { inputs: [true, false, undefined], expected: [true, true, false, true] },
    { inputs: [true, false, true], expected: [true, false, false, true] },
    { inputs: [true, false, false], expected: [true, true, false, true] },
    // memory explicitly off — no tier is active, but the explicit v2
    // opt-out is still visible
    {
      inputs: [false, undefined, undefined],
      expected: [false, false, false, false],
    },
    {
      inputs: [false, undefined, true],
      expected: [false, false, false, false],
    },
    {
      inputs: [false, undefined, false],
      expected: [false, false, false, false],
    },
    {
      inputs: [false, true, undefined],
      expected: [false, false, false, false],
    },
    { inputs: [false, true, true], expected: [false, false, false, false] },
    { inputs: [false, true, false], expected: [false, false, false, false] },
    {
      inputs: [false, false, undefined],
      expected: [false, false, false, true],
    },
    { inputs: [false, false, true], expected: [false, false, false, true] },
    { inputs: [false, false, false], expected: [false, false, false, true] },
  ];

  const show = (v: TriState) => (v === undefined ? "unset" : String(v));

  for (const { inputs, expected } of rows) {
    const [enabled, v2Enabled, v3Live] = inputs;
    const [expEnabled, expV1, expV2Engine, expV2Disabled] = expected;
    test(`enabled=${show(enabled)} v2.enabled=${show(v2Enabled)} v3.live=${show(v3Live)}`, () => {
      const config = makeConfig(enabled, v2Enabled, v3Live);
      expect(isMemoryEnabled(config)).toBe(expEnabled);
      expect(isMemoryV1Active(config)).toBe(expV1);
      expect(isV2InjectionEngineActive(config)).toBe(expV2Engine);
      expect(isMemoryV2ExplicitlyDisabled(config)).toBe(expV2Disabled);
      // The predicates and memoryTier() share one implementation; assert the
      // tier buckets agree with the predicates on every combination.
      expect(isMemoryEnabled(config)).toBe(memoryTier(config) !== "off");
      expect(isMemoryV1Active(config)).toBe(memoryTier(config) === "v1");
      expect(isV2InjectionEngineActive(config)).toBe(
        memoryTier(config) === "v2",
      );
    });
  }

  test("empty config: memory on, v1 is the live tier", () => {
    const config = {} as AssistantConfig;
    expect(isMemoryEnabled(config)).toBe(true);
    expect(isMemoryV1Active(config)).toBe(true);
    expect(isV2InjectionEngineActive(config)).toBe(false);
    expect(isMemoryV2ExplicitlyDisabled(config)).toBe(false);
  });

  test("v2.enabled stays true on v3-live assistants; the engine predicate still reports inactive", () => {
    // No migration writes memory.v2.enabled=false at v3 cutover, so a
    // v3-live config typically still carries v2.enabled=true. A direct
    // `memory.v2.enabled` read says "on"; the predicate must say "off".
    const config = makeConfig(undefined, true, true);
    expect(config.memory?.v2?.enabled).toBe(true);
    expect(isV2InjectionEngineActive(config)).toBe(false);
    // The substrate is still active — v3 is a concept-page consumer.
    expect(usesConceptPageMemory(config.memory)).toBe(true);
  });
});
