import { describe, expect, test } from "bun:test";

import { memoryTier } from "./memory-tier.js";
import {
  isMemoryEnabled,
  isMemoryV1Active,
  isMemoryV2ExplicitlyDisabled,
  isMemoryV3Live,
  isV2InjectionEngineActive,
  isV3TierActive,
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
  // [isMemoryEnabled, isMemoryV1Active, isV2InjectionEngineActive,
  //  isMemoryV2ExplicitlyDisabled, isV3TierActive].
  // undefined = key unset. Covers all 27 {enabled, v2.enabled, v3.live}
  // tri-state combinations.
  //
  // The nine `enabled: false` rows are the decided memory-off semantics, and
  // they are what makes the predicates non-interchangeable with the raw
  // substrate/live reads: with memory off NO tier is active — not v1
  // (`isMemoryV1Active` false even though `usesConceptPageMemory` is also
  // false) and not v3 (`isV3TierActive` false even with `memory.v3.live`
  // set). Every tier-scoped code path asks these predicates for that reason.
  const rows: Array<{
    inputs: [TriState, TriState, TriState];
    expected: [boolean, boolean, boolean, boolean, boolean];
  }> = [
    // memory on by default (enabled unset)
    {
      inputs: [undefined, undefined, undefined],
      expected: [true, true, false, false, false],
    },
    {
      inputs: [undefined, undefined, true],
      expected: [true, false, false, false, true],
    },
    {
      inputs: [undefined, undefined, false],
      expected: [true, true, false, false, false],
    },
    {
      inputs: [undefined, true, undefined],
      expected: [true, false, true, false, false],
    },
    {
      inputs: [undefined, true, true],
      expected: [true, false, false, false, true],
    },
    {
      inputs: [undefined, true, false],
      expected: [true, false, true, false, false],
    },
    {
      inputs: [undefined, false, undefined],
      expected: [true, true, false, true, false],
    },
    {
      inputs: [undefined, false, true],
      expected: [true, false, false, true, true],
    },
    {
      inputs: [undefined, false, false],
      expected: [true, true, false, true, false],
    },
    // memory explicitly on
    {
      inputs: [true, undefined, undefined],
      expected: [true, true, false, false, false],
    },
    {
      inputs: [true, undefined, true],
      expected: [true, false, false, false, true],
    },
    {
      inputs: [true, undefined, false],
      expected: [true, true, false, false, false],
    },
    {
      inputs: [true, true, undefined],
      expected: [true, false, true, false, false],
    },
    {
      inputs: [true, true, true],
      expected: [true, false, false, false, true],
    },
    {
      inputs: [true, true, false],
      expected: [true, false, true, false, false],
    },
    {
      inputs: [true, false, undefined],
      expected: [true, true, false, true, false],
    },
    {
      inputs: [true, false, true],
      expected: [true, false, false, true, true],
    },
    {
      inputs: [true, false, false],
      expected: [true, true, false, true, false],
    },
    // memory explicitly off — no tier is active (v3-live included:
    // `isV3TierActive` is false), but the explicit v2 opt-out is still visible
    {
      inputs: [false, undefined, undefined],
      expected: [false, false, false, false, false],
    },
    {
      inputs: [false, undefined, true],
      expected: [false, false, false, false, false],
    },
    {
      inputs: [false, undefined, false],
      expected: [false, false, false, false, false],
    },
    {
      inputs: [false, true, undefined],
      expected: [false, false, false, false, false],
    },
    {
      inputs: [false, true, true],
      expected: [false, false, false, false, false],
    },
    {
      inputs: [false, true, false],
      expected: [false, false, false, false, false],
    },
    {
      inputs: [false, false, undefined],
      expected: [false, false, false, true, false],
    },
    {
      inputs: [false, false, true],
      expected: [false, false, false, true, false],
    },
    {
      inputs: [false, false, false],
      expected: [false, false, false, true, false],
    },
  ];

  const show = (v: TriState) => (v === undefined ? "unset" : String(v));

  for (const { inputs, expected } of rows) {
    const [enabled, v2Enabled, v3Live] = inputs;
    const [expEnabled, expV1, expV2Engine, expV2Disabled, expV3Tier] = expected;
    test(`enabled=${show(enabled)} v2.enabled=${show(v2Enabled)} v3.live=${show(v3Live)}`, () => {
      const config = makeConfig(enabled, v2Enabled, v3Live);
      expect(isMemoryEnabled(config)).toBe(expEnabled);
      expect(isMemoryV1Active(config)).toBe(expV1);
      expect(isV2InjectionEngineActive(config)).toBe(expV2Engine);
      expect(isMemoryV2ExplicitlyDisabled(config)).toBe(expV2Disabled);
      expect(isV3TierActive(config)).toBe(expV3Tier);
      // The predicates and memoryTier() share one implementation; assert every
      // tier bucket agrees with the predicates on every combination. This is
      // memoryTier()'s coverage — all four buckets are pinned here, so it needs
      // no separate test file.
      expect(isMemoryEnabled(config)).toBe(memoryTier(config) !== "off");
      expect(isMemoryV1Active(config)).toBe(memoryTier(config) === "v1");
      expect(isV2InjectionEngineActive(config)).toBe(
        memoryTier(config) === "v2",
      );
      // `"off"` outranks `"v3"`, so the v3 bucket is the live-AND-enabled
      // conjunction rather than `isMemoryV3Live` alone — which is exactly what
      // `isV3TierActive` names.
      expect(isV3TierActive(config)).toBe(memoryTier(config) === "v3");
      expect(isV3TierActive(config)).toBe(
        isMemoryV3Live(config) && isMemoryEnabled(config),
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
    // v2.enabled and v3.live may both be true; only the v3 injection engine
    // is active then. A direct `memory.v2.enabled` read says "on"; the
    // predicate must say "off".
    const config = makeConfig(undefined, true, true);
    expect(config.memory?.v2?.enabled).toBe(true);
    expect(isV2InjectionEngineActive(config)).toBe(false);
    // The substrate is still active — v3 is a concept-page consumer.
    expect(usesConceptPageMemory(config.memory)).toBe(true);
  });
});

/**
 * The v1-staleness guard used to have three spellings that disagreed when
 * memory is off: `usesConceptPageMemory(config.memory)` at job dispatch,
 * `!isMemoryV1Active(config)` in the graph handlers, and a re-inlined
 * `usesConceptPageMemory` on the `graph_extract` handler. All three now read
 * `isMemoryV1Active`, and these tests pin both halves of that: the two
 * spellings agree everywhere EXCEPT memory-off, and memory-off skips v1 work.
 */
describe("v1-staleness guard is one condition", () => {
  const memoryOff = makeConfig(false, undefined, undefined);
  const v1Tier = makeConfig(undefined, false, false);
  const v2Tier = makeConfig(undefined, true, false);
  const v3Tier = makeConfig(undefined, true, true);

  test("v1 work runs on the v1 tier and nowhere else", () => {
    expect(isMemoryV1Active(v1Tier)).toBe(true);
    expect(isMemoryV1Active(v2Tier)).toBe(false);
    expect(isMemoryV1Active(v3Tier)).toBe(false);
    expect(isMemoryV1Active(memoryOff)).toBe(false);
  });

  test("memory-off is the one state where the old spellings disagreed", () => {
    // The former dispatch-level spelling. Identical on every tier…
    for (const config of [v1Tier, v2Tier, v3Tier]) {
      expect(isMemoryV1Active(config)).toBe(
        !usesConceptPageMemory(config.memory),
      );
    }
    // …and wrong with memory off: the substrate check reports "not concept
    // pages", which the old guard read as "v1 is live" and kept v1 work
    // running. The named predicate says v1 is not the tier.
    expect(usesConceptPageMemory(memoryOff.memory)).toBe(false);
    expect(isMemoryV1Active(memoryOff)).toBe(false);
  });

  test("an explicit v2 opt-out with memory off still is not the v1 tier", () => {
    // `memory.v2.enabled: false` puts a memory-ON assistant on v1; memory off
    // outranks that.
    expect(isMemoryV1Active(makeConfig(true, false, false))).toBe(true);
    expect(isMemoryV1Active(makeConfig(false, false, false))).toBe(false);
  });
});

/**
 * `isV3TierActive` replaced two predicates that disagreed on memory-off: the
 * memory-graph capability check (which honored the opt-out) and a
 * proc-to-skills alias of `isMemoryV3Live` (which did not). One predicate now
 * answers for both features.
 */
describe("v3 tier is one condition", () => {
  test("memory off suppresses the v3 tier even with memory.v3.live set", () => {
    const config = makeConfig(false, undefined, true);
    // The raw key is still set — only the tier predicate accounts for the
    // opt-out, which is why feature gates must not read `isMemoryV3Live`.
    expect(isMemoryV3Live(config)).toBe(true);
    expect(isV3TierActive(config)).toBe(false);
  });

  test("v3 live with memory on is the v3 tier", () => {
    expect(isV3TierActive(makeConfig(true, undefined, true))).toBe(true);
    expect(isV3TierActive(makeConfig(undefined, undefined, true))).toBe(true);
  });

  test("false when v3 is not live, and on an empty config", () => {
    expect(isV3TierActive(makeConfig(undefined, undefined, false))).toBe(false);
    expect(isV3TierActive({} as AssistantConfig)).toBe(false);
  });
});
