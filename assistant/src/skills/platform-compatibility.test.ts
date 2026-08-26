import { describe, expect, test } from "bun:test";

import { assistantEventHub } from "../runtime/assistant-event-hub.js";
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

  test("rejects a Windows browser without a capable host on Windows", () => {
    const skill = { platforms: ["windows"] as const };
    expect(
      isSkillCompatibleWithClientPlatform(skill, "windows", "win32", []),
    ).toBe(false);
  });

  test("does not use another actor's capable host", () => {
    const hostClient = assistantEventHub.subscribe({
      type: "client",
      clientId: "platform-compatibility-actor-b-host",
      interfaceId: "windows",
      capabilities: ["host_bash"],
      actorPrincipalId: "actor-b",
      callback: () => {},
    });
    try {
      const skill = { platforms: ["windows"] as const };
      expect(
        isSkillCompatibleWithClientPlatform(
          skill,
          "windows",
          "linux",
          undefined,
          "actor-a",
        ),
      ).toBe(false);
      expect(
        isSkillCompatibleWithClientPlatform(
          skill,
          "windows",
          "linux",
          undefined,
          "actor-b",
        ),
      ).toBe(true);
    } finally {
      hostClient.dispose();
    }
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

  test("filters client-routed surfaces by the capable host platform", () => {
    const skills = [
      { id: "linux-only", platforms: ["linux"] as const },
      { id: "windows-only", platforms: ["windows"] as const },
      { id: "mac-only", platforms: ["macos"] as const },
    ];

    expect(
      filterSkillsByClientPlatform(skills, "windows", "linux", ["windows"]).map(
        (skill) => skill.id,
      ),
    ).toEqual(["windows-only"]);
  });

  test("normalizes valid unique metadata values", () => {
    expect(normalizeSkillPlatforms(["windows", "windows", "linux"])).toEqual([
      "windows",
      "linux",
    ]);
    expect(normalizeSkillPlatforms(["android", 42])).toBeUndefined();
  });
});
