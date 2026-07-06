import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { RiskLevel } from "../permissions/types.js";
import {
  __clearRegistryForTesting,
  __resetRegistryForTesting,
  getAllToolDefinitions,
  getAllTools,
  getCoreToolOverride,
  getSkillRefCount,
  getSkillToolNames,
  getTool,
  getToolOwner,
  getWorkspaceToolNames,
  initializeTools,
  registerPluginTools,
  registerSkillTools,
  registerTool,
  registerWorkspaceTools,
  unregisterSkillTools,
  unregisterWorkspaceTool,
} from "../tools/registry.js";
import { explicitTools } from "../tools/tool-manifest.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";

// Clean up global registry after this file completes to prevent
// contamination of subsequent test files in combined runs.
afterAll(() => {
  __resetRegistryForTesting();
});

function makeFakeTool(name: string): Tool {
  return {
    name,
    description: `Fake ${name}`,
    category: "test",
    defaultRiskLevel: RiskLevel.Low,
    executionTarget: "sandbox",
    // Match the finalized shape the registry stores, so identity comparisons
    // (`getTool(name)` toEqual coreTool) hold after registration fills defaults.
    exclusive: false,
    input_schema: { type: "object", properties: {}, required: [] },
    async execute(
      _input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolExecutionResult> {
      return { content: "ok", isError: false };
    },
  };
}

function makeSkillTool(name: string): Tool {
  // Ownership is recorded by the registry (via `registerSkillTools`), not by
  // any field on the Tool itself. This helper is now a thin alias for
  // makeFakeTool; the wrapper is kept so call sites stay readable.
  return makeFakeTool(name);
}

describe("tool registry host tools", () => {
  test("registers host tools and exposes them in tool definitions", async () => {
    await initializeTools();

    const hostToolNames = [
      "host_file_read",
      "host_file_write",
      "host_file_edit",
      "host_bash",
    ] as const;

    for (const toolName of hostToolNames) {
      const tool = getTool(toolName);
      expect(tool).toBeDefined();
      expect(tool?.defaultRiskLevel).toBe(RiskLevel.Medium);
    }

    const definitionNames = getAllToolDefinitions().map((def) => def.name);
    for (const toolName of hostToolNames) {
      expect(definitionNames).toContain(toolName);
    }
  });
});

describe("tool registry dynamic-tools tools", () => {
  test("registers skill_load tool", async () => {
    await initializeTools();

    const tool = getTool("skill_load");
    expect(tool).toBeDefined();

    const definitionNames = getAllToolDefinitions().map((def) => def.name);
    expect(definitionNames).toContain("skill_load");
  });

  test("scaffold and delete are NOT in the core tool registry (moved to bundled skill)", async () => {
    await initializeTools();
    // scaffold_managed_skill and delete_managed_skill moved to the
    // skill-management bundled skill — they are no longer registered as core
    // tools. Their High risk classification is handled by classifyRisk() in
    // checker.ts so security behavior is preserved.
    expect(getTool("scaffold_managed_skill")).toBeUndefined();
    expect(getTool("delete_managed_skill")).toBeUndefined();
  });

  test("skill_load is registered as Low risk", async () => {
    await initializeTools();
    const tool = getTool("skill_load");
    expect(tool).toBeDefined();
    expect(tool?.defaultRiskLevel).toBe(RiskLevel.Low);
  });
});

describe("tool manifest", () => {
  test("explicit tools list includes memory tools", () => {
    const names = explicitTools.map((t) => t.name);
    expect(names).toContain("recall");
    expect(names.filter((name) => name === "recall")).toHaveLength(1);
    expect(names).toContain("remember");
  });

  test("initializeTools registers every explicit manifest tool", async () => {
    await initializeTools();
    const registered = new Set(getAllTools().map((t) => t.name));
    for (const tool of explicitTools) {
      expect(registered.has(tool.name!), `expected "${tool.name}"`).toBe(true);
    }
  });
});

describe("baseline characterization: hardcoded tool loading", () => {
  test("version is NOT registered in the global registry after initializeTools()", async () => {
    await initializeTools();
    expect(getTool("version")).toBeUndefined();
  });

  test("gmail tools are NOT registered in the global registry after initializeTools()", async () => {
    await initializeTools();
    const allTools = getAllTools();
    const toolNames = allTools.map((t) => t.name);

    const gmailTools = [
      "gmail_search",
      "gmail_list_messages",
      "gmail_get_message",
      "gmail_mark_read",
      "gmail_draft",
      "gmail_archive",
      "gmail_label",
      "gmail_trash",
      "gmail_send",
      "gmail_unsubscribe",
    ];
    for (const name of gmailTools) {
      expect(toolNames).not.toContain(name);
    }
  });

  test("gmail tool names are NOT in the explicit tool manifest", () => {
    const gmailTools = [
      "gmail_search",
      "gmail_list_messages",
      "gmail_get_message",
      "gmail_mark_read",
      "gmail_draft",
      "gmail_archive",
      "gmail_label",
      "gmail_trash",
      "gmail_send",
      "gmail_unsubscribe",
    ];
    const explicitNames = explicitTools.map((t) => t.name);
    for (const name of gmailTools) {
      expect(explicitNames).not.toContain(name);
    }
  });
});

describe("baseline characterization: core app tool surface", () => {
  test("non-proxy app tools are NOT in core registry (now skill-provided)", async () => {
    await initializeTools();

    const nonProxyAppTools = [
      "app_create",
      "app_delete",
      "app_generate_icon",
      "app_refresh",
    ];

    for (const name of nonProxyAppTools) {
      const tool = getTool(name);
      expect(tool).toBeUndefined();
    }

    const definitionNames = getAllToolDefinitions().map((def) => def.name);
    for (const name of nonProxyAppTools) {
      expect(definitionNames).not.toContain(name);
    }
  });

  test("core registry includes app_open proxy tool", async () => {
    await initializeTools();

    const tool = getTool("app_open");
    expect(tool).toBeDefined();

    // app_open is core-owned (no skill owner) so it flows through
    // `getAllToolDefinitions()` like any other core tool.
    const definitionNames = getAllToolDefinitions().map((def) => def.name);
    expect(definitionNames).toContain("app_open");
  });

  test("bundled app-builder skill has TOOLS.json manifest", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");

    // Resolve the bundled skill directory relative to the source config
    const skillDir = path.resolve(
      import.meta.dirname,
      "../config/bundled-skills/app-builder",
    );
    const toolsJsonPath = path.join(skillDir, "TOOLS.json");

    expect(fs.existsSync(toolsJsonPath)).toBe(true);
  });
});

describe("tool ownership metadata", () => {
  beforeEach(() => {
    __resetRegistryForTesting();
  });

  test("registerTool does not record ownership (bare-install path)", () => {
    registerTool(makeFakeTool("test-bare-tool"));

    expect(getTool("test-bare-tool")).toBeDefined();
    // `registerTool` is the bare-install path used by tests + core
    // bootstraps; it does not record ownership. Tools that need an owner
    // must go through `registerSkillTools(skillId, ...)` or its sibling
    // entry points so the registry populates `ownersByName`.
    expect(getToolOwner("test-bare-tool")).toBeUndefined();
  });

  test("core tools have no owner", async () => {
    await initializeTools();

    expect(getTool("host_file_read")).toBeDefined();
    expect(getToolOwner("host_file_read")).toBeUndefined();
  });
});

describe("dynamic skill tool registry", () => {
  beforeEach(() => {
    __resetRegistryForTesting();
  });

  test("registers skill tools and retrieves them with owner via getToolOwner", () => {
    registerSkillTools("my-skill", [
      makeSkillTool("sk_tool_a"),
      makeSkillTool("sk_tool_b"),
    ]);

    expect(getTool("sk_tool_a")).toBeDefined();
    expect(getToolOwner("sk_tool_a")).toEqual({
      kind: "skill",
      id: "my-skill",
    });

    expect(getTool("sk_tool_b")).toBeDefined();
    expect(getToolOwner("sk_tool_b")).toEqual({
      kind: "skill",
      id: "my-skill",
    });
  });

  test("skips skill tool that collides with a core tool without throwing", async () => {
    await initializeTools();

    // host_file_read is a core tool registered during init
    const accepted = registerSkillTools("rogue-skill", [
      makeSkillTool("host_file_read"),
    ]);

    // The colliding tool should be silently skipped
    expect(accepted).toHaveLength(0);
    // The core tool should still be in place (not overwritten)
    expect(getTool("host_file_read")).toBeDefined();
    expect(getToolOwner("host_file_read")).toBeUndefined();
  });

  test("allows replacement within the same owning skill", () => {
    registerSkillTools("owner-skill", [makeSkillTool("sk_replaceable")]);

    const replacement: Tool = {
      ...makeSkillTool("sk_replaceable"),
      description: "Updated description",
    };
    // Should not throw
    registerSkillTools("owner-skill", [replacement]);

    const retrieved = getTool("sk_replaceable");
    expect(retrieved?.description).toBe("Updated description");
  });

  test("rejects replacement from a different owning skill", () => {
    registerSkillTools("skill-alpha", [makeSkillTool("sk_owned")]);

    expect(() =>
      registerSkillTools("skill-beta", [makeSkillTool("sk_owned")]),
    ).toThrow('already registered by skill "skill-alpha"');
  });

  test("unregisterSkillTools removes all tools for a skill", () => {
    registerSkillTools("removable-skill", [
      makeSkillTool("sk_rm_1"),
      makeSkillTool("sk_rm_2"),
    ]);
    expect(getTool("sk_rm_1")).toBeDefined();
    expect(getTool("sk_rm_2")).toBeDefined();

    unregisterSkillTools("removable-skill");

    expect(getTool("sk_rm_1")).toBeUndefined();
    expect(getTool("sk_rm_2")).toBeUndefined();
    // Ownership map is cleared in lockstep with the tools map.
    expect(getToolOwner("sk_rm_1")).toBeUndefined();
    expect(getToolOwner("sk_rm_2")).toBeUndefined();
  });

  test("unregisterSkillTools does not affect tools from other skills", () => {
    registerSkillTools("keep-skill", [makeSkillTool("sk_keep")]);
    registerSkillTools("nuke-skill", [makeSkillTool("sk_remove")]);

    unregisterSkillTools("nuke-skill");

    expect(getTool("sk_keep")).toBeDefined();
    expect(getTool("sk_remove")).toBeUndefined();
    expect(getToolOwner("sk_keep")).toEqual({
      kind: "skill",
      id: "keep-skill",
    });
    expect(getToolOwner("sk_remove")).toBeUndefined();
  });

  test("getSkillToolNames returns only skill tool names", async () => {
    await initializeTools();

    registerSkillTools("names-skill", [
      makeSkillTool("sk_names_a"),
      makeSkillTool("sk_names_b"),
    ]);

    const skillNames = getSkillToolNames();
    expect(skillNames).toContain("sk_names_a");
    expect(skillNames).toContain("sk_names_b");
    // Core tools should not appear
    expect(skillNames).not.toContain("host_file_read");
    expect(skillNames).not.toContain("bash");
  });

  test("registerSkillTools skips core-colliding tools but registers the rest", async () => {
    await initializeTools();

    const accepted = registerSkillTools("atomic-skill", [
      makeSkillTool("sk_atomic_ok"),
      makeSkillTool("host_file_read"), // collides with core
    ]);
    // Only the non-colliding tool should be accepted
    expect(accepted).toHaveLength(1);
    expect(accepted[0].name).toBe("sk_atomic_ok");
    // The non-colliding tool should be registered with the correct owner
    expect(getTool("sk_atomic_ok")).toBeDefined();
    expect(getToolOwner("sk_atomic_ok")).toEqual({
      kind: "skill",
      id: "atomic-skill",
    });
    // The core tool should be untouched (no owner recorded)
    expect(getTool("host_file_read")).toBeDefined();
    expect(getToolOwner("host_file_read")).toBeUndefined();
  });
});

describe("skill tool reference counting", () => {
  beforeEach(() => {
    __resetRegistryForTesting();
  });

  test("ref count increments on each registerSkillTools call", () => {
    registerSkillTools("rc-skill", [makeSkillTool("rc_a")]);
    expect(getSkillRefCount("rc-skill")).toBe(1);

    // Second session registers the same skill (same owner id allows replacement)
    registerSkillTools("rc-skill", [makeSkillTool("rc_a")]);
    expect(getSkillRefCount("rc-skill")).toBe(2);
  });

  test("unregister decrements ref count but keeps tools when count > 0", () => {
    registerSkillTools("rc-multi", [makeSkillTool("rc_keep")]);
    registerSkillTools("rc-multi", [makeSkillTool("rc_keep")]);
    expect(getSkillRefCount("rc-multi")).toBe(2);

    unregisterSkillTools("rc-multi");
    expect(getSkillRefCount("rc-multi")).toBe(1);
    // Tools still present
    expect(getTool("rc_keep")).toBeDefined();
  });

  test("tools are removed only when last reference is unregistered", () => {
    registerSkillTools("rc-final", [makeSkillTool("rc_last")]);
    registerSkillTools("rc-final", [makeSkillTool("rc_last")]);

    unregisterSkillTools("rc-final");
    expect(getTool("rc_last")).toBeDefined();

    unregisterSkillTools("rc-final");
    expect(getTool("rc_last")).toBeUndefined();
    expect(getSkillRefCount("rc-final")).toBe(0);
  });

  test("unregister with no prior registration is a no-op", () => {
    unregisterSkillTools("nonexistent-skill");
    expect(getSkillRefCount("nonexistent-skill")).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Workspace tool overrides
//
// Tests the registry surface exposed by registerWorkspaceTools /
// unregisterWorkspaceTool / getCoreToolOverride / getWorkspaceToolNames.
// The loader (workspace-tools/loader.ts) is tested separately — these
// tests treat the registry contract as the source of truth and exercise
// it directly with synthetic tool objects.
// ─────────────────────────────────────────────────────────────────────

function makeWorkspaceInput(
  name: string,
  workspacePath = `/workspace/tools/${name}.ts`,
): { tool: Tool; workspacePath: string } {
  return {
    workspacePath,
    tool: {
      name,
      category: "workspace",
      description: `Workspace ${name}`,
      defaultRiskLevel: RiskLevel.Low,
      executionTarget: "sandbox",
      input_schema: { type: "object", properties: {}, required: [] },
      async execute(
        _input: Record<string, unknown>,
        _context: ToolContext,
      ): Promise<ToolExecutionResult> {
        return { content: `workspace ${name}`, isError: false };
      },
    },
  };
}

function makeLoadedPluginTool(name: string): Tool {
  return {
    name,
    category: "plugin",
    description: `Plugin ${name}`,
    defaultRiskLevel: RiskLevel.Low,
    executionTarget: "sandbox",
    input_schema: { type: "object", properties: {}, required: [] },
    async execute(
      _input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolExecutionResult> {
      return { content: `plugin ${name}`, isError: false };
    },
  };
}

describe("workspace tool registry", () => {
  beforeEach(() => {
    __resetRegistryForTesting();
  });

  test("net-new workspace tool registers without stashing anything", () => {
    __clearRegistryForTesting();

    const accepted = registerWorkspaceTools([makeWorkspaceInput("new_tool")]);

    expect(accepted).toHaveLength(1);
    const tool = getTool("new_tool");
    expect(tool).toBeDefined();
    expect(getToolOwner("new_tool")).toEqual({
      kind: "workspace",
      id: "/workspace/tools/new_tool.ts",
    });
    expect(getCoreToolOverride("new_tool")).toBeUndefined();
    expect(getWorkspaceToolNames()).toEqual(["new_tool"]);
  });

  test("workspace tool with same name as core stashes the original", () => {
    __clearRegistryForTesting();
    const coreTool = makeFakeTool("override_target");
    registerTool(coreTool);
    expect(getTool("override_target")).toEqual(coreTool);

    registerWorkspaceTools([makeWorkspaceInput("override_target")]);

    // Live registry now points at the workspace tool.
    const live = getTool("override_target");
    expect(live).toBeDefined();
    expect(getToolOwner("override_target")?.kind).toBe("workspace");
    expect(getToolOwner("override_target")?.kind).toBe("workspace");

    // Stash preserves the original for later restoration.
    expect(getCoreToolOverride("override_target")).toEqual(coreTool);
  });

  test("unregister restores the stashed core tool when one exists", () => {
    __clearRegistryForTesting();
    const coreTool = makeFakeTool("restore_me");
    registerTool(coreTool);
    registerWorkspaceTools([makeWorkspaceInput("restore_me")]);
    expect(getToolOwner("restore_me")?.kind).toBe("workspace");

    unregisterWorkspaceTool("restore_me");

    expect(getTool("restore_me")).toEqual(coreTool);
    expect(getCoreToolOverride("restore_me")).toBeUndefined();
    expect(getWorkspaceToolNames()).toEqual([]);
  });

  test("unregister deletes the tool when no core counterpart was stashed", () => {
    __clearRegistryForTesting();
    registerWorkspaceTools([makeWorkspaceInput("only_workspace")]);
    expect(getTool("only_workspace")).toBeDefined();

    unregisterWorkspaceTool("only_workspace");

    expect(getTool("only_workspace")).toBeUndefined();
    expect(getCoreToolOverride("only_workspace")).toBeUndefined();
  });

  test("unregister is a no-op on a non-workspace name", () => {
    __clearRegistryForTesting();
    const coreTool = makeFakeTool("not_workspace");
    registerTool(coreTool);

    unregisterWorkspaceTool("not_workspace");
    unregisterWorkspaceTool("never_existed");

    expect(getTool("not_workspace")).toEqual(coreTool);
  });

  test("re-registering an existing workspace tool throws (single canonical source)", () => {
    __clearRegistryForTesting();
    registerWorkspaceTools([
      makeWorkspaceInput("dupe", "/workspace/tools/dupe"),
    ]);

    expect(() =>
      registerWorkspaceTools([
        makeWorkspaceInput("dupe", "/workspace/tools/dupe"),
      ]),
    ).toThrow(/already registered/);
  });

  test("duplicate names within a single batch throw (no partial application)", () => {
    __clearRegistryForTesting();

    expect(() =>
      registerWorkspaceTools([
        makeWorkspaceInput("twin"),
        makeWorkspaceInput("twin", "/workspace/tools/twin-alt"),
      ]),
    ).toThrow(/duplicate name/);

    // Mutation phase never ran — registry stays empty for this name.
    expect(getTool("twin")).toBeUndefined();
    expect(getWorkspaceToolNames()).toEqual([]);
  });

  test("batch rejection leaves earlier-batch tools un-mutated", () => {
    __clearRegistryForTesting();

    // Pre-occupy "guarded" as a skill tool — workspace tools cannot
    // override skill tools (only core), so the batch must throw and
    // leave the otherwise-fine "ok_a" / "ok_b" entries unregistered.
    registerSkillTools("skill-a", [makeSkillTool("guarded")]);

    expect(() =>
      registerWorkspaceTools([
        makeWorkspaceInput("ok_a"),
        makeWorkspaceInput("guarded"),
        makeWorkspaceInput("ok_b"),
      ]),
    ).toThrow(/conflicts with an existing/);

    expect(getTool("ok_a")).toBeUndefined();
    expect(getTool("ok_b")).toBeUndefined();
    // The skill tool is still in the registry, untouched.
    expect(getToolOwner("guarded")?.kind).toBe("skill");
  });

  test("workspace tool blocks subsequent plugin registration with same name", () => {
    __clearRegistryForTesting();
    registerWorkspaceTools([makeWorkspaceInput("contested")]);

    // Plugin attempts to register over a workspace-owned name. The
    // registry's plugin-registration path warn-skips rather than
    // throwing, mirroring the core-conflict behavior.
    const accepted = registerPluginTools("some-plugin", [
      makeLoadedPluginTool("contested"),
    ]);

    expect(accepted).toEqual([]);
    expect(getToolOwner("contested")?.kind).toBe("workspace");
  });

  test("workspace tool blocks subsequent skill registration with same name", () => {
    __clearRegistryForTesting();
    registerWorkspaceTools([makeWorkspaceInput("skill_attempt")]);

    const accepted = registerSkillTools("some-skill", [
      makeSkillTool("skill_attempt"),
    ]);

    expect(accepted).toEqual([]);
    expect(getToolOwner("skill_attempt")?.kind).toBe("workspace");
    expect(getSkillToolNames()).toEqual([]);
  });

  test("__resetRegistryForTesting clears the override stash", () => {
    __clearRegistryForTesting();
    const coreTool = makeFakeTool("baseline_tool");
    registerTool(coreTool);
    registerWorkspaceTools([makeWorkspaceInput("baseline_tool")]);
    expect(getCoreToolOverride("baseline_tool")).toEqual(coreTool);

    __resetRegistryForTesting();

    expect(getCoreToolOverride("baseline_tool")).toBeUndefined();
  });

  test("workspace tool overrides surface as the live tool in getAllToolDefinitions", () => {
    __clearRegistryForTesting();
    const coreTool = makeFakeTool("listed_tool");
    registerTool(coreTool);
    registerWorkspaceTools([makeWorkspaceInput("listed_tool")]);

    const definitions = getAllToolDefinitions();
    const ours = definitions.find((d) => d.name === "listed_tool");
    expect(ours).toBeDefined();
    // The live workspace tool defines its own description; ensure the
    // definition does not leak the core tool's description.
    expect(ours?.description).toBe("Workspace listed_tool");
  });
});
