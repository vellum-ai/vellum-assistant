import { describe, expect, test } from "bun:test";

import { usesConceptPageMemory } from "./memory-v3-gate.js";

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
