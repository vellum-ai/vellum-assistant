import { describe, expect, test } from "bun:test";

import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import {
  filterSkillsByContext,
  isSkillCompatibleWithContext,
  normalizeRequiredHostCapabilities,
  normalizeSkillPlatforms,
  resolveSkillTurnIsInteractive,
  skillPlatformForClientOs,
  skillPlatformForNodePlatform,
  skillPlatformUnavailableMessage,
} from "./platform-compatibility.js";

describe("skill platform compatibility", () => {
  test("uses frozen turn presence before live connection state", () => {
    expect(
      resolveSkillTurnIsInteractive({
        isNonInteractive: true,
        hasNoClient: false,
      }),
    ).toBe(false);
    expect(
      resolveSkillTurnIsInteractive({
        isNonInteractive: false,
        hasNoClient: false,
      }),
    ).toBe(true);
    expect(resolveSkillTurnIsInteractive({ hasNoClient: false })).toBe(true);
    expect(resolveSkillTurnIsInteractive({ hasNoClient: true })).toBe(false);
  });

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

  test("requires each capability in a direct local host proof", () => {
    const context = {
      clientOs: "windows",
      isInteractive: true,
      sourceActorPrincipalId: "actor-a",
      hostPlatforms: [{ platform: "windows", capabilities: ["host_bash"] }],
    } as const;
    expect(
      isSkillCompatibleWithContext(
        {
          platforms: ["windows"],
          requiredHostCapabilities: ["host_bash"],
        },
        context,
      ),
    ).toBe(true);
    expect(
      isSkillCompatibleWithContext(
        {
          platforms: ["windows"],
          requiredHostCapabilities: ["host_cu"],
        },
        context,
      ),
    ).toBe(false);
    expect(
      isSkillCompatibleWithContext(
        {
          platforms: ["windows"],
          requiredHostCapabilities: ["host_bash", "host_app_control"],
        },
        context,
      ),
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

  test("reports missing host access separately from an operating system mismatch", () => {
    const skill = {
      platforms: ["windows"] as const,
      requiredHostCapabilities: ["host_bash"] as const,
    };
    expect(
      skillPlatformUnavailableMessage("windows-automation", skill, {
        clientOs: "windows",
        isInteractive: true,
        sourceActorPrincipalId: "actor-a",
        hostPlatforms: [],
      }),
    ).toBe(
      'Skill "windows-automation" requires a connected host that provides: host_bash. Reconnect a compatible desktop app and try again.',
    );
    expect(
      skillPlatformUnavailableMessage("windows-automation", skill, {
        clientOs: "windows",
        isInteractive: false,
        sourceActorPrincipalId: "actor-a",
        hostPlatforms: ["windows"],
      }),
    ).toContain("requires an interactive turn");
    expect(
      skillPlatformUnavailableMessage("windows-automation", skill, {
        clientOs: "macos",
        isInteractive: true,
        sourceActorPrincipalId: "actor-a",
        hostPlatforms: ["macos"],
      }),
    ).toContain("unavailable on this operating system");
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

  test("accepts capable hosts without desktop platform identities", () => {
    const hostClient = assistantEventHub.subscribe({
      type: "client",
      clientId: "platform-compatibility-browser-host",
      interfaceId: "chrome-extension",
      capabilities: ["host_browser"],
      actorPrincipalId: "actor-a",
      callback: () => {},
    });
    try {
      expect(
        isSkillCompatibleWithContext(
          { requiredHostCapabilities: ["host_browser"] },
          {
            clientOs: "web",
            isInteractive: true,
            sourceActorPrincipalId: "actor-a",
          },
        ),
      ).toBe(true);
      expect(
        isSkillCompatibleWithContext(
          {
            platforms: ["windows"],
            requiredHostCapabilities: ["host_browser"],
          },
          {
            clientOs: "web",
            isInteractive: true,
            sourceActorPrincipalId: "actor-a",
          },
        ),
      ).toBe(false);
    } finally {
      hostClient.dispose();
    }
  });

  test("accepts explicit capability proof without a desktop platform", () => {
    const context = {
      clientOs: "web",
      isInteractive: true,
      sourceActorPrincipalId: "actor-a",
      hostPlatforms: [
        { platform: "chrome-extension", capabilities: ["host_browser"] },
      ],
    };

    expect(
      isSkillCompatibleWithContext(
        { requiredHostCapabilities: ["host_browser"] },
        context,
      ),
    ).toBe(true);
    expect(
      isSkillCompatibleWithContext(
        {
          platforms: ["windows"],
          requiredHostCapabilities: ["host_browser"],
        },
        context,
      ),
    ).toBe(false);
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
    expect(normalizeRequiredHostCapabilities([])).toEqual({});
    expect(normalizeRequiredHostCapabilities(undefined)).toEqual({});
  });

  test("preserves malformed host capability declarations for fail-closed checks", () => {
    for (const malformed of ["host_bash", { capability: "host_bash" }, null]) {
      expect(
        normalizeRequiredHostCapabilities(malformed)
          .unsupportedHostCapabilities,
      ).toEqual(["<invalid-required-host-capabilities>"]);
    }
    expect(
      normalizeRequiredHostCapabilities(["host_bash", null])
        .unsupportedHostCapabilities,
    ).toEqual(["<invalid-required-host-capabilities>"]);
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
