import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { isProcToSkillsEnabled } from "../memory-v3-gate.js";
import type { AssistantConfig } from "../schema.js";
import { MemoryConfigSchema } from "../schemas/memory.js";

const PROC_TO_SKILLS_FLAG = "procedural-memory-as-skills";

beforeEach(() => {
  setOverridesForTesting({});
});

afterEach(() => {
  setOverridesForTesting({});
});

describe("memory.procToSkills config", () => {
  test("defaults minRecurrence to 2 when unset", () => {
    const parsed = MemoryConfigSchema.parse({});
    expect(parsed.procToSkills).toEqual({ minRecurrence: 2 });
  });

  test("accepts an explicit minRecurrence override", () => {
    const parsed = MemoryConfigSchema.parse({
      procToSkills: { minRecurrence: 3 },
    });
    expect(parsed.procToSkills.minRecurrence).toBe(3);
  });

  test("rejects a minRecurrence below 1 or non-integer", () => {
    expect(() =>
      MemoryConfigSchema.parse({ procToSkills: { minRecurrence: 0 } }),
    ).toThrow();
    expect(() =>
      MemoryConfigSchema.parse({ procToSkills: { minRecurrence: 1.5 } }),
    ).toThrow();
  });
});

describe("isProcToSkillsEnabled", () => {
  const config = {} as AssistantConfig;

  test("returns false by default (flag off)", () => {
    expect(isProcToSkillsEnabled(config)).toBe(false);
  });

  test("returns true when the flag is enabled", () => {
    setOverridesForTesting({ [PROC_TO_SKILLS_FLAG]: true });
    expect(isProcToSkillsEnabled(config)).toBe(true);
  });
});
