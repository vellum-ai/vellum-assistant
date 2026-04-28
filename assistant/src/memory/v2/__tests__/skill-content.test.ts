/**
 * Tests for `memory/v2/skill-content.ts` — v2-owned port of v1's
 * `buildSkillContent` plus the `mcp-setup` description augmentation.
 */
import { describe, expect, mock, test } from "bun:test";

import type { SkillCapabilityInput } from "../../../skills/skill-memory.js";

describe("buildSkillContent", () => {
  test("renders minimal input with id, displayName, description", async () => {
    const { buildSkillContent } = await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "example-skill",
      displayName: "Example Skill",
      description: "Does an example thing",
    };
    expect(buildSkillContent(input)).toBe(
      'The "Example Skill" skill (example-skill) is available. Does an example thing.',
    );
  });

  test("includes both activationHints and avoidWhen clauses", async () => {
    const { buildSkillContent } = await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "example-skill",
      displayName: "Example Skill",
      description: "Does an example thing",
      activationHints: ["user mentions example", "task involves examples"],
      avoidWhen: ["user is busy", "topic is unrelated"],
    };
    const out = buildSkillContent(input);
    expect(out).toContain(
      "Use when: user mentions example; task involves examples.",
    );
    expect(out).toContain("Avoid when: user is busy; topic is unrelated.");
  });

  test("caps output at 500 characters", async () => {
    const { buildSkillContent } = await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "example-skill",
      displayName: "Example Skill",
      description: "x".repeat(1000),
    };
    const out = buildSkillContent(input);
    expect(out.length).toBeLessThanOrEqual(500);
  });
});

describe("augmentMcpSetupDescription", () => {
  test("is a no-op when id is not mcp-setup", async () => {
    const { augmentMcpSetupDescription } = await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "example-skill",
      displayName: "Example Skill",
      description: "Does an example thing",
    };
    expect(augmentMcpSetupDescription(input)).toBe(input);
  });

  test("appends 'Configured: <names>' for mcp-setup with enabled servers", async () => {
    mock.module("../../../config/loader.js", () => ({
      getConfig: () => ({
        mcp: {
          servers: {
            "example-server": { enabled: true },
            "another-server": { enabled: true },
            "disabled-server": { enabled: false },
          },
        },
      }),
    }));
    const { augmentMcpSetupDescription } = await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "mcp-setup",
      displayName: "MCP Setup",
      description: "Configures MCP servers",
    };
    const out = augmentMcpSetupDescription(input);
    expect(out.description).toBe(
      "Configures MCP servers Configured: example-server, another-server",
    );
    expect(out.id).toBe("mcp-setup");
  });
});
