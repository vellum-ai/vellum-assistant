import { describe, expect, test } from "bun:test";

import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import {
  filterSkillsByContext,
  isSkillCompatibleWithContext,
  normalizeSkillPlatforms,
  skillPlatformForClientOs,
} from "./platform-compatibility.js";

describe("skill platform compatibility", () => {
  test("maps desktop client operating systems to skill platforms", () => {
    expect(skillPlatformForClientOs("macos")).toBe("macos");
    expect(skillPlatformForClientOs("windows")).toBe("windows");
    expect(skillPlatformForClientOs("web")).toBeNull();
  });

  test("treats missing platform metadata as portable", () => {
    expect(isSkillCompatibleWithContext({}, {})).toBe(true);
  });

  test("matches a capable connected host when the assistant host differs", () => {
    const skill = { platforms: ["windows"] as const };
    expect(
      isSkillCompatibleWithContext(skill, {
        clientOs: "windows",
        isInteractive: true,
        sourceActorPrincipalId: "actor-a",
        hostPlatforms: ["windows"],
      }),
    ).toBe(true);
    expect(
      isSkillCompatibleWithContext(skill, {
        clientOs: "windows",
        isInteractive: true,
        sourceActorPrincipalId: "actor-a",
        hostPlatforms: [],
      }),
    ).toBe(false);
    expect(
      isSkillCompatibleWithContext(skill, {
        clientOs: "macos",
        isInteractive: true,
        sourceActorPrincipalId: "actor-a",
        hostPlatforms: ["windows"],
      }),
    ).toBe(false);
  });

  test("rejects a Windows browser without a capable host on Windows", () => {
    const skill = { platforms: ["windows"] as const };
    expect(
      isSkillCompatibleWithContext(skill, {
        clientOs: "windows",
        isInteractive: true,
        sourceActorPrincipalId: "actor-a",
        hostPlatforms: [],
      }),
    ).toBe(false);
  });

  test("rejects clientless turns even when a capable host is connected", () => {
    const skill = { platforms: ["windows"] as const };
    expect(
      isSkillCompatibleWithContext(skill, {
        clientOs: "windows",
        isInteractive: false,
        sourceActorPrincipalId: "actor-a",
        hostPlatforms: ["windows"],
      }),
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
        isSkillCompatibleWithContext(skill, {
          clientOs: "windows",
          isInteractive: true,
          sourceActorPrincipalId: "actor-a",
        }),
      ).toBe(false);
      expect(
        isSkillCompatibleWithContext(skill, {
          clientOs: "windows",
          isInteractive: true,
          sourceActorPrincipalId: "actor-b",
        }),
      ).toBe(true);
    } finally {
      hostClient.dispose();
    }
  });

  test("filters client-routed surfaces by the capable host platform", () => {
    const skills = [
      { id: "linux-only", platforms: ["linux"] as const },
      { id: "windows-only", platforms: ["windows"] as const },
      { id: "mac-only", platforms: ["macos"] as const },
    ];

    expect(
      filterSkillsByContext(skills, {
        clientOs: "windows",
        isInteractive: true,
        sourceActorPrincipalId: "actor-a",
        hostPlatforms: ["windows"],
      }).map((skill) => skill.id),
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
