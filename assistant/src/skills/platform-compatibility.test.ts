import { describe, expect, test } from "bun:test";

import {
  filterSkillsByPlatform,
  isSkillCompatibleWithPlatform,
  normalizeSkillPlatforms,
  skillPlatformForNodePlatform,
} from "./platform-compatibility.js";

describe("skill platform compatibility", () => {
  test("maps Node platforms to skill platform names", () => {
    expect(skillPlatformForNodePlatform("darwin")).toBe("macos");
    expect(skillPlatformForNodePlatform("win32")).toBe("windows");
    expect(skillPlatformForNodePlatform("linux")).toBe("linux");
    expect(skillPlatformForNodePlatform("freebsd")).toBeNull();
  });

  test("treats missing platform metadata as portable", () => {
    expect(isSkillCompatibleWithPlatform({}, "win32")).toBe(true);
    expect(isSkillCompatibleWithPlatform({}, "linux")).toBe(true);
  });

  test("matches declared host platforms", () => {
    const skill = { platforms: ["macos", "linux"] as const };
    expect(isSkillCompatibleWithPlatform(skill, "darwin")).toBe(true);
    expect(isSkillCompatibleWithPlatform(skill, "linux")).toBe(true);
    expect(isSkillCompatibleWithPlatform(skill, "win32")).toBe(false);
  });

  test("filters incompatible skills from offer surfaces", () => {
    const skills = [
      { id: "portable" },
      { id: "mac-only", platforms: ["macos"] as const },
      { id: "windows-only", platforms: ["windows"] as const },
    ];

    expect(
      filterSkillsByPlatform(skills, "win32").map((skill) => skill.id),
    ).toEqual(["portable", "windows-only"]);
  });

  test("normalizes valid unique metadata values", () => {
    expect(normalizeSkillPlatforms(["windows", "windows", "linux"])).toEqual([
      "windows",
      "linux",
    ]);
    expect(normalizeSkillPlatforms(["android", 42])).toBeUndefined();
  });
});
