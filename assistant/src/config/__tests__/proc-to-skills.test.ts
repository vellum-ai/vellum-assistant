import { describe, expect, test } from "bun:test";

import { isProcToSkillsActive } from "../memory-v3-gate.js";
import type { AssistantConfig } from "../schema.js";

describe("isProcToSkillsActive (v3-live)", () => {
  const v3Live = { memory: { v3: { live: true } } } as AssistantConfig;
  const v3NotLive = { memory: { v3: { live: false } } } as AssistantConfig;

  test("false when v3 is not live", () => {
    expect(isProcToSkillsActive(v3NotLive)).toBe(false);
  });

  test("false by default (no v3 config)", () => {
    expect(isProcToSkillsActive({} as AssistantConfig)).toBe(false);
  });

  test("true when v3 is live", () => {
    expect(isProcToSkillsActive(v3Live)).toBe(true);
  });
});
