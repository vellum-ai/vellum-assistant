/**
 * Tests for `substrate/skill-content.ts` — v2-owned port of v1's
 * `buildSkillContent` plus the `mcp-setup` description augmentation.
 */
import { describe, expect, test } from "bun:test";

import { setConfig } from "../../../../../__tests__/helpers/set-config.js";
import type { SkillCapabilityInput } from "../skill-content.js";

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

  test("respects a larger maxChars budget", async () => {
    const { buildSkillContent } = await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "example-skill",
      displayName: "Example Skill",
      description: "x".repeat(1000),
    };
    const out = buildSkillContent(input, 900);
    expect(out.length).toBeLessThanOrEqual(900);
    expect(out.length).toBeGreaterThan(500);
  });

  test("renders hints as a bulleted list when the budget is enlarged", async () => {
    const { buildSkillContent } = await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "wf",
      displayName: "Workflows",
      description: "Delegate a big job",
      activationHints: ["Batch many items", "Exhaustive sweep"],
      avoidWhen: ["A single lookup"],
    };
    const rich = buildSkillContent(input, 900);
    expect(rich).toContain("Use when:\n- Batch many items\n- Exhaustive sweep");
    expect(rich).toContain("Avoid when:\n- A single lookup");
    // The default (500) budget keeps the compact inline form.
    expect(buildSkillContent(input)).toContain(
      "Use when: Batch many items; Exhaustive sweep.",
    );
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

  test("appends 'Configured: <names>' for mcp-setup with configured servers", async () => {
    setConfig("mcp", {
      servers: {
        "example-server": {
          transport: { type: "stdio", command: "example-cmd" },
        },
        "another-server": {
          transport: { type: "stdio", command: "another-cmd" },
        },
      },
    });
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

describe("SKILLS_INJECTION_CATALOG_HINT", () => {
  test("points a missing product at plugin and skill search", async () => {
    const { SKILLS_INJECTION_CATALOG_HINT } =
      await import("../skill-content.js");
    expect(SKILLS_INJECTION_CATALOG_HINT).toContain(
      "assistant plugins search <name>",
    );
    expect(SKILLS_INJECTION_CATALOG_HINT).toContain(
      "assistant skills search <name>",
    );
    expect(SKILLS_INJECTION_CATALOG_HINT.toLowerCase()).toContain(
      "currently in the workspace",
    );
  });
});

describe("renderSkillCard", () => {
  test("keeps the hints the budget would cut", async () => {
    const { buildSkillContent, renderSkillCard } =
      await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "verbose",
      displayName: "Verbose",
      description: "x".repeat(480),
      activationHints: ["the user asks for the verbose thing"],
      avoidWhen: ["anything else"],
    };
    const budgeted = buildSkillContent(input, 500);
    const full = renderSkillCard(input, 500);

    expect(budgeted.length).toBe(500);
    expect(full.length).toBeGreaterThan(500);
    expect(full.startsWith(budgeted)).toBe(true);
    expect(full).toContain("Use when: the user asks for the verbose thing.");
    expect(full).toContain("Avoid when: anything else.");
  });

  test("matches buildSkillContent when the card fits the budget", async () => {
    const { buildSkillContent, renderSkillCard } =
      await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "short",
      displayName: "Short",
      description: "Does one small thing",
      activationHints: ["the user asks for it"],
    };
    expect(renderSkillCard(input, 500)).toBe(buildSkillContent(input, 500));
  });

  test("uses the bulleted layout at the always-candidate budget", async () => {
    const { renderSkillCard } = await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "pinned",
      displayName: "Pinned",
      description: "Always in the pool",
      activationHints: ["first mode", "second mode"],
    };
    expect(renderSkillCard(input, 900)).toContain(
      "Use when:\n- first mode\n- second mode",
    );
  });
});
