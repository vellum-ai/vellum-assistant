/**
 * Tests for the `tools` route handler (operationId `tools_get`), which backs
 * both the macOS permission-simulator catalog (`names`/`schemas`) and the
 * `assistant tools list` CLI command (`tools`). The `tools` array carries
 * every registered tool with its description, author-asserted risk band,
 * category, and the source (core / skill / plugin / mcp) that contributed it
 * — with the source read from the registry's ownership map rather than off
 * the tool object.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import { RiskLevel } from "../permissions/types.js";
import { ROUTES } from "../runtime/routes/settings-routes.js";
import {
  __resetRegistryForTesting,
  registerMcpTools,
  registerPluginTools,
  registerSkillTools,
  registerTool,
} from "../tools/registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";
import { getWorkspacePluginsDir } from "../util/platform.js";

interface ToolListEntry {
  name: string;
  description: string;
  riskLevel: string;
  category: string;
  source: string;
}

interface ToolsGetResponse {
  names: string[];
  schemas: Record<string, unknown>;
  tools: ToolListEntry[];
}

function makeFakeTool(name: string, extras: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `Fake ${name}`,
    defaultRiskLevel: RiskLevel.Low,
    executionTarget: "sandbox",
    input_schema: { type: "object", properties: {}, required: [] },
    category: "",
    async execute(
      _input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolExecutionResult> {
      return { content: "ok", isError: false };
    },
    ...extras,
  };
}

const handler = (() => {
  const route = ROUTES.find(
    (r) => r.endpoint === "tools" && r.method === "GET",
  );
  if (!route) {
    throw new Error("No route found for GET tools");
  }
  return route.handler;
})();

/**
 * Minimal Conversation stand-in exposing only the tool-snapshot accessor the
 * route reads, registered into the live conversation registry by id.
 */
function registerFakeConversation(id: string, toolNames: string[]): void {
  setConversation(id, {
    getRegisteredToolDefinitions: () =>
      toolNames.map((name) => ({ name, description: "", input_schema: {} })),
  } as unknown as Conversation);
}

/** Drop a `.disabled` sentinel into a plugin's workspace directory. */
function disablePluginSentinel(name: string): void {
  const dir = join(getWorkspacePluginsDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".disabled"), "");
}

describe("GET /tools", () => {
  beforeEach(() => {
    __resetRegistryForTesting();
    clearConversations();
  });

  afterEach(() => {
    // Remove any `.disabled` sentinels written during a test so plugin
    // disabled-state never leaks across cases.
    rmSync(join(getWorkspacePluginsDir(), "git-workflow"), {
      recursive: true,
      force: true,
    });
  });

  test("returns each registered tool's metadata, sorted by name, with core source", async () => {
    // GIVEN two core tools registered out of alphabetical order
    registerTool(
      makeFakeTool("b_core_tool", {
        description: "Beta tool",
        defaultRiskLevel: RiskLevel.High,
        category: "testing",
      }),
    );
    registerTool(makeFakeTool("a_core_tool"));

    // WHEN the tools handler runs
    const { names, schemas, tools } = (await handler({})) as ToolsGetResponse;

    // THEN the catalog fields the permission simulator reads are present
    expect(names).toContain("a_core_tool");
    expect(names).toContain("b_core_tool");
    expect(schemas.a_core_tool).toBeDefined();

    // AND the metadata array is sorted by name with full per-tool metadata
    const toolNames = tools.map((t) => t.name);
    expect(toolNames.indexOf("a_core_tool")).toBeLessThan(
      toolNames.indexOf("b_core_tool"),
    );
    expect([...toolNames]).toEqual(
      [...toolNames].sort((a, b) => a.localeCompare(b)),
    );

    // AND each built-in tool reports "default:default" as its source plus metadata
    const beta = tools.find((t) => t.name === "b_core_tool");
    expect(beta).toEqual({
      name: "b_core_tool",
      description: "Beta tool",
      riskLevel: RiskLevel.High,
      category: "testing",
      source: "default:default",
    });
  });

  test("reports plugin, mcp, and skill tools as <kind>:<id>", async () => {
    // GIVEN one tool from each non-core source
    registerPluginTools("echo", [makeFakeTool("p_tool")]);
    registerMcpTools("linear", [makeFakeTool("m_tool")]);
    registerSkillTools("my-skill", [makeFakeTool("s_tool")]);

    // WHEN the tools handler runs
    const { tools } = (await handler({})) as ToolsGetResponse;

    // THEN each tool's source encodes its owning extension
    const sourceOf = (name: string) =>
      tools.find((t) => t.name === name)?.source;
    expect(sourceOf("p_tool")).toBe("plugin:echo");
    expect(sourceOf("m_tool")).toBe("mcp:linear");
    expect(sourceOf("s_tool")).toBe("skill:my-skill");
  });

  test("excludes tools contributed by a disabled plugin", async () => {
    // GIVEN a core tool and a plugin tool, both initially registered
    registerTool(makeFakeTool("a_core_tool"));
    registerPluginTools("git-workflow", [makeFakeTool("gw_tool")]);

    // THEN the plugin tool is visible before disabling
    const before = (await handler({})) as ToolsGetResponse;
    expect(before.names).toContain("gw_tool");
    expect(before.tools.some((t) => t.name === "gw_tool")).toBe(true);
    expect(before.schemas.gw_tool).toBeDefined();

    // WHEN the plugin is disabled via its `.disabled` sentinel
    disablePluginSentinel("git-workflow");

    // THEN the plugin's tool drops from names, schemas, and the metadata
    // array on the next call — no daemon restart required — while the core
    // tool stays put.
    const after = (await handler({})) as ToolsGetResponse;
    expect(after.names).not.toContain("gw_tool");
    expect(after.tools.some((t) => t.name === "gw_tool")).toBe(false);
    expect(after.schemas.gw_tool).toBeUndefined();
    expect(after.names).toContain("a_core_tool");
  });

  test("with conversationId, scopes to the conversation's tool snapshot and resolves metadata from the registry", async () => {
    // GIVEN three core tools in the global registry
    registerTool(makeFakeTool("a_core_tool"));
    registerTool(
      makeFakeTool("b_core_tool", {
        description: "Beta tool",
        defaultRiskLevel: RiskLevel.High,
        category: "testing",
      }),
    );
    registerTool(makeFakeTool("c_core_tool"));

    // AND a conversation whose most-recent-turn snapshot saw only two of them
    registerFakeConversation("conv-1", ["c_core_tool", "a_core_tool"]);

    // WHEN the handler runs with that conversationId
    const { names, schemas, tools } = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as ToolsGetResponse;

    // THEN only the conversation's tools are returned, sorted, with schemas
    expect(names).toEqual(["a_core_tool", "c_core_tool"]);
    expect(tools.map((t) => t.name)).toEqual(["a_core_tool", "c_core_tool"]);
    expect(schemas.a_core_tool).toBeDefined();
    expect(schemas.b_core_tool).toBeUndefined();

    // AND each entry's metadata is resolved from the global registry
    expect(tools.find((t) => t.name === "a_core_tool")?.source).toBe(
      "default:default",
    );
  });

  test("with conversationId, marks a snapshot tool absent from the registry as unknown", async () => {
    // GIVEN a conversation snapshot referencing a since-unloaded skill tool
    registerFakeConversation("conv-1", ["ghost_skill_tool"]);

    // WHEN the handler runs with that conversationId
    const { tools } = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as ToolsGetResponse;

    // THEN the tool still appears, with unknown source and empty metadata
    expect(tools).toEqual([
      {
        name: "ghost_skill_tool",
        description: "",
        riskLevel: "unknown",
        category: "",
        source: "unknown",
      },
    ]);
  });

  test("with an unknown conversationId, throws a 404 RouteError", () => {
    // GIVEN no conversation registered under the queried id
    // WHEN the handler runs with a missing conversationId
    // THEN it throws an actionable not-found error
    expect(() =>
      handler({ queryParams: { conversationId: "missing" } }),
    ).toThrow(/No active conversation "missing"/);
  });

  test("with agent=role, simulates the subagent tool projection", async () => {
    // GIVEN core tools including ones in and out of the researcher allowlist
    registerTool(makeFakeTool("web_search"));
    registerTool(makeFakeTool("web_fetch"));
    registerTool(makeFakeTool("file_read"));
    registerTool(makeFakeTool("file_list"));
    registerTool(makeFakeTool("recall"));
    registerTool(makeFakeTool("notify_parent"));
    // These should be filtered out for the researcher role:
    registerTool(makeFakeTool("bash"));
    registerTool(makeFakeTool("file_write"));
    registerTool(makeFakeTool("file_edit"));

    // WHEN the handler runs with agent=researcher
    const { names } = (await handler({
      queryParams: { agent: "researcher" },
    })) as ToolsGetResponse;

    // THEN only the researcher allowlist tools are returned
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    expect(names).toContain("file_read");
    expect(names).toContain("file_list");
    expect(names).toContain("recall");
    expect(names).toContain("notify_parent");
    // And tools outside the allowlist are excluded
    expect(names).not.toContain("bash");
    expect(names).not.toContain("file_write");
    expect(names).not.toContain("file_edit");
  });

  test("with agent=general, returns all tools (no allowlist filter)", async () => {
    // GIVEN core tools
    registerTool(makeFakeTool("web_search"));
    registerTool(makeFakeTool("bash"));
    registerTool(makeFakeTool("notify_parent"));

    // WHEN the handler runs with agent=general (allowedTools: undefined)
    const { names } = (await handler({
      queryParams: { agent: "general" },
    })) as ToolsGetResponse;

    // THEN all registered tools are visible — the general role has no
    // allowlist, so nothing is filtered
    expect(names).toContain("web_search");
    expect(names).toContain("bash");
    expect(names).toContain("notify_parent");
  });

  test("with agent=role, notify_parent is visible (subagent-only gating works)", async () => {
    // GIVEN notify_parent registered as a core tool
    registerTool(makeFakeTool("notify_parent"));

    // WHEN the handler runs with agent=coder
    const { names, tools } = (await handler({
      queryParams: { agent: "coder" },
    })) as ToolsGetResponse;

    // THEN notify_parent appears because isSubagent=true satisfies
    // the SUBAGENT_ONLY_TOOL_NAMES gate in isToolActiveForContext
    expect(names).toContain("notify_parent");
    expect(tools.some((t) => t.name === "notify_parent")).toBe(true);
  });

  test("with an unknown agent, throws a 404 RouteError", () => {
    expect(() =>
      handler({ queryParams: { agent: "nonexistent_role" } }),
    ).toThrow(/Unknown agent "nonexistent_role"/);
  });
});
