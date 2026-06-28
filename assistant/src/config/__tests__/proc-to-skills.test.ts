import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import {
  isProcToSkillsActive,
  isProcToSkillsEnabled,
} from "../memory-v3-gate.js";
import type { AssistantConfig } from "../schema.js";

const PROC_TO_SKILLS_FLAG = "procedural-memory-as-skills";

beforeEach(() => {
  setOverridesForTesting({});
});

afterEach(() => {
  setOverridesForTesting({});
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

describe("isProcToSkillsActive (flag AND v3-live)", () => {
  const v3Live = { memory: { v3: { live: true } } } as AssistantConfig;
  const v3NotLive = { memory: { v3: { live: false } } } as AssistantConfig;

  test("false when the flag is off, even with v3 live", () => {
    expect(isProcToSkillsActive(v3Live)).toBe(false);
  });

  test("false when the flag is on but v3 is not live", () => {
    setOverridesForTesting({ [PROC_TO_SKILLS_FLAG]: true });
    expect(isProcToSkillsActive(v3NotLive)).toBe(false);
  });

  test("true only when the flag is on AND v3 is live", () => {
    setOverridesForTesting({ [PROC_TO_SKILLS_FLAG]: true });
    expect(isProcToSkillsActive(v3Live)).toBe(true);
  });
});
