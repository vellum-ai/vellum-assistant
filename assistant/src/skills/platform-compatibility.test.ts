import { describe, expect, test } from "bun:test";

import {
  filterSkillsByClientPlatform,
  filterSkillsByPlatform,
  isSkillCompatibleWithClientPlatform,
  isSkillCompatibleWithPlatform,
  normalizeSkillPlatforms,
  skillPlatformForClientOs,
  skillPlatformForNodePlatform,
} from "./platform-compatibility.js";

describe("skill platform compatibility", () => {
  test("maps Node platforms to skill platform names", () => {
    expect(skillPlatformForNodePlatform("darwin")).toBe("macos");
    expect(skillPlatformForNodePlatform("win32")).toBe("windows");
    expect(skillPlatformForNodePlatform("linux")).toBe("linux");
    expect(skillPlatformForNodePlatform("freebsd")).toBeNull();
  });

  test("maps desktop client operating systems to skill platforms", () => {
    expect(skillPlatformForClientOs("macos")).toBe("macos");
    expect(skillPlatformForClientOs("windows")).toBe("windows");
    expect(skillPlatformForClientOs("web")).toBeNull();
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

  test("matches a capable connected host when the assistant host differs", () => {
    const skill = { platforms: ["windows"] as const };
    expect(
      isSkillCompatibleWithClientPlatform(skill, "windows", "linux", [
        "windows",
      ]),
    ).toBe(true);
    expect(
      isSkillCompatibleWithClientPlatform(skill, "windows", "linux", []),
    ).toBe(false);
    expect(
      isSkillCompatibleWithClientPlatform(skill, "macos", "linux", ["windows"]),
    ).toBe(false);
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

  test("filters offer surfaces by assistant or connected client platform", () => {
    const skills = [
      { id: "linux-only", platforms: ["linux"] as const },
      { id: "windows-only", platforms: ["windows"] as const },
      { id: "mac-only", platforms: ["macos"] as const },
    ];

    expect(
      filterSkillsByClientPlatform(skills, "windows", "linux", ["windows"]).map(
        (skill) => skill.id,
      ),
    ).toEqual(["linux-only", "windows-only"]);
  });

  test("normalizes valid unique metadata values", () => {
    expect(normalizeSkillPlatforms(["windows", "windows", "linux"])).toEqual([
      "windows",
      "linux",
    ]);
    expect(normalizeSkillPlatforms(["android", 42])).toBeUndefined();
  });
});
