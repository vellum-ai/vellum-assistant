import { describe, expect, test } from "bun:test";

import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import {
  filterSkillsByContext,
  isSkillCompatibleWithContext,
  normalizeRequiredHostCapabilities,
  normalizeSkillPlatforms,
  skillPlatformForClientOs,
  skillPlatformForNodePlatform,
} from "./platform-compatibility.js";

describe("skill platform compatibility", () => {
  test("maps desktop client operating systems to skill platforms", () => {
    expect(skillPlatformForClientOs("macos")).toBe("macos");
    expect(skillPlatformForClientOs("windows")).toBe("windows");
    expect(skillPlatformForClientOs("web")).toBeNull();
    expect(skillPlatformForNodePlatform("linux")).toBe("linux");
  });

  test("treats missing platform metadata as portable", () => {
    expect(isSkillCompatibleWithContext({}, {})).toBe(true);
  });

  test("allows daemon-host skills for browser turns on a supported daemon OS", () => {
    const skill = { platforms: ["macos", "linux"] as const };
    expect(
      isSkillCompatibleWithContext(skill, {
        clientOs: "web",
        isInteractive: true,
        daemonPlatform: "linux",
      }),
    ).toBe(true);
    expect(
      isSkillCompatibleWithContext(skill, {
        clientOs: "web",
        isInteractive: true,
        daemonPlatform: "win32",
      }),
    ).toBe(false);
  });

  test("matches a required capable host when the assistant host differs", () => {
    const skill = {
      platforms: ["windows"] as const,
      requiredHostCapabilities: ["host_bash"] as const,
    };
    expect(
      isSkillCompatibleWithContext(skill, {
        clientOs: "web",
        isInteractive: true,
        sourceActorPrincipalId: "actor-a",
        hostPlatforms: ["windows"],
      }),
    ).toBe(true);
    expect(
      isSkillCompatibleWithContext(skill, {
        clientOs: "web",
        isInteractive: true,
        sourceActorPrincipalId: "actor-a",
        hostPlatforms: [],
      }),
    ).toBe(false);
  });

  test("rejects a Windows browser without a capable host on Windows", () => {
    const skill = {
      platforms: ["windows"] as const,
      requiredHostCapabilities: ["host_bash"] as const,
    };
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
    const skill = {
      platforms: ["windows"] as const,
      requiredHostCapabilities: ["host_bash"] as const,
    };
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
      const skill = {
        platforms: ["windows"] as const,
        requiredHostCapabilities: ["host_bash"] as const,
      };
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
      {
        id: "windows-host",
        platforms: ["windows"] as const,
        requiredHostCapabilities: ["host_bash"] as const,
      },
      { id: "mac-only", platforms: ["macos"] as const },
    ];

    expect(
      filterSkillsByContext(skills, {
        clientOs: "windows",
        isInteractive: true,
        sourceActorPrincipalId: "actor-a",
        hostPlatforms: ["windows"],
        daemonPlatform: "linux",
      }).map((skill) => skill.id),
    ).toEqual(["linux-only", "windows-host"]);
  });

  test("normalizes valid unique metadata values", () => {
    expect(normalizeSkillPlatforms(["windows", "windows", "linux"])).toEqual([
      "windows",
      "linux",
    ]);
    expect(normalizeSkillPlatforms(["android", 42])).toBeUndefined();
    expect(
      normalizeRequiredHostCapabilities([
        "host_bash",
        "host_bash",
        "not-a-capability",
      ]),
    ).toEqual({
      requiredHostCapabilities: ["host_bash"],
      unsupportedHostCapabilities: ["not-a-capability"],
    });
    expect(
      normalizeRequiredHostCapabilities(["future_host_capability"]),
    ).toEqual({
      unsupportedHostCapabilities: ["future_host_capability"],
    });
  });

  test("rejects all-invalid and mixed host capability requirements", () => {
    const context = {
      isInteractive: true,
      sourceActorPrincipalId: "actor-a",
      hostPlatforms: ["windows"],
    };
    expect(
      isSkillCompatibleWithContext(
        { unsupportedHostCapabilities: ["future_host_capability"] },
        context,
      ),
    ).toBe(false);
    expect(
      isSkillCompatibleWithContext(
        {
          requiredHostCapabilities: ["host_bash"],
          unsupportedHostCapabilities: ["future_host_capability"],
        },
        context,
      ),
    ).toBe(false);
  });
});
