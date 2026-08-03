/**
 * Skill-catalog filtering for the advisor context pack: the section must list
 * only skills the conversation can actually load, mirroring the `skill_load`
 * gates: plugin-owned skills outside the per-chat plugin scope and skills
 * whose feature flag is off are omitted.
 *
 * Mocks are isolated to this file (the test runner runs each file in its own
 * process), so the broad module stubs here don't leak into other suites.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../../config/skills.js", () => ({
  loadSkillCatalog: () => [
    { id: "bundled-skill", name: "bundled-skill", description: "Bundled." },
    {
      id: "scoped-skill",
      name: "scoped-skill",
      description: "In-scope plugin skill.",
      owner: { kind: "plugin", id: "enabled-plugin" },
    },
    {
      id: "out-of-scope-skill",
      name: "out-of-scope-skill",
      description: "Out-of-scope plugin skill.",
      owner: { kind: "plugin", id: "disabled-plugin" },
    },
    {
      id: "flag-off-skill",
      name: "flag-off-skill",
      description: "Flag-gated skill.",
      featureFlag: "some-flag",
    },
  ],
}));
mock.module("../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => false,
}));
mock.module("../../config/loader.js", () => ({
  getConfig: () => ({ memory: { retrieval: {} }, llm: {} }),
}));
// Keep the other sections empty so the assertions isolate the skills catalog.
mock.module("../../daemon/trust-context.js", () => ({
  isPersonalMemoryAllowed: () => false,
}));
mock.module("../../daemon/conversation-workspace.js", () => ({
  resolveWorkspaceTopLevelContext: () => null,
}));
mock.module("../../daemon/conversation-runtime-assembly.js", () => ({
  buildActiveDocuments: () => null,
}));

const { buildAdvisorContext } = await import("../consult-context.js");

const baseSources = {
  conversationId: "c1",
  workingDir: "/tmp/does-not-exist-consult-skills",
  trustClass: "guardian" as const,
  allowedToolNames: new Set<string>(),
};

describe("advisor context pack: skill catalog filtering", () => {
  test("omits plugin skills outside the per-chat scope and flag-off skills", async () => {
    const ctx =
      (await buildAdvisorContext({
        ...baseSources,
        enabledPluginSet: new Set(["enabled-plugin"]),
      })) ?? "";
    expect(ctx).toContain("bundled-skill");
    expect(ctx).toContain("scoped-skill");
    expect(ctx).not.toContain("out-of-scope-skill");
    expect(ctx).not.toContain("flag-off-skill");
  });

  test("a null plugin scope imposes no plugin restriction", async () => {
    const ctx =
      (await buildAdvisorContext({
        ...baseSources,
        enabledPluginSet: null,
      })) ?? "";
    expect(ctx).toContain("out-of-scope-skill");
  });
});
