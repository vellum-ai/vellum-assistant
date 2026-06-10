/**
 * Tests for the `tools/list` route handler (operationId `tools_list`),
 * which backs the `assistant tools list` CLI command. It returns every
 * registered tool with its description, author-asserted risk band,
 * category, and the source (core / skill / plugin / mcp) that contributed
 * it — with the source read from the registry's ownership map rather than
 * off the tool object.
 */

import { beforeEach, describe, expect, test } from "bun:test";

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

interface ToolListEntry {
  name: string;
  description: string;
  riskLevel: string;
  category: string;
  source: string;
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
    (r) => r.endpoint === "tools/list" && r.method === "GET",
  );
  if (!route) {
    throw new Error("No route found for GET tools/list");
  }
  return route.handler;
})();

describe("GET /tools/list", () => {
  beforeEach(() => {
    __resetRegistryForTesting();
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

    // WHEN the tools/list handler runs
    const { tools } = (await handler({})) as { tools: ToolListEntry[] };

    // THEN our tools are present, sorted by name, with full metadata
    const names = tools.map((t) => t.name);
    expect(names.indexOf("a_core_tool")).toBeLessThan(
      names.indexOf("b_core_tool"),
    );
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));

    // AND each core tool reports "core" as its source plus its metadata
    const beta = tools.find((t) => t.name === "b_core_tool");
    expect(beta).toEqual({
      name: "b_core_tool",
      description: "Beta tool",
      riskLevel: RiskLevel.High,
      category: "testing",
      source: "core",
    });
  });

  test("reports plugin, mcp, and skill tools as <kind>:<id>", async () => {
    // GIVEN one tool from each non-core source
    registerPluginTools("echo", [makeFakeTool("p_tool")]);
    registerMcpTools("linear", [makeFakeTool("m_tool")]);
    registerSkillTools("my-skill", [makeFakeTool("s_tool")]);

    // WHEN the tools/list handler runs
    const { tools } = (await handler({})) as { tools: ToolListEntry[] };

    // THEN each tool's source encodes its owning extension
    const sourceOf = (name: string) =>
      tools.find((t) => t.name === name)?.source;
    expect(sourceOf("p_tool")).toBe("plugin:echo");
    expect(sourceOf("m_tool")).toBe("mcp:linear");
    expect(sourceOf("s_tool")).toBe("skill:my-skill");
  });
});
