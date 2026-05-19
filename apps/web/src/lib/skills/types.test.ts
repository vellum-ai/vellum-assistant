import { describe, expect, test } from "bun:test";

import {
  isAvailableSkill,
  isInstalledSkill,
  isRemovableSkill,
  type SkillInfo,
} from "@/lib/skills/types.js";

function makeSkill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id: "test-skill",
    name: "Test",
    description: "A test skill.",
    kind: "installed",
    status: "enabled",
    origin: "vellum",
    ...overrides,
  };
}

describe("skill status helpers", () => {
  test("isInstalledSkill is true for kind === 'installed'", () => {
    expect(isInstalledSkill(makeSkill({ kind: "installed" }))).toBe(true);
  });

  test("isInstalledSkill is true for kind === 'bundled'", () => {
    expect(isInstalledSkill(makeSkill({ kind: "bundled" }))).toBe(true);
  });

  test("isInstalledSkill is false for kind === 'catalog'", () => {
    expect(isInstalledSkill(makeSkill({ kind: "catalog" }))).toBe(false);
  });

  test("isAvailableSkill is true only for catalog skills", () => {
    expect(isAvailableSkill(makeSkill({ kind: "catalog" }))).toBe(true);
    expect(isAvailableSkill(makeSkill({ kind: "installed" }))).toBe(false);
    expect(isAvailableSkill(makeSkill({ kind: "bundled" }))).toBe(false);
  });

  test("isRemovableSkill is true only for user-installed skills", () => {
    expect(isRemovableSkill(makeSkill({ kind: "installed" }))).toBe(true);
    expect(isRemovableSkill(makeSkill({ kind: "bundled" }))).toBe(false);
    expect(isRemovableSkill(makeSkill({ kind: "catalog" }))).toBe(false);
  });
});
