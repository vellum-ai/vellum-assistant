/**
 * Tests for the per-chat plugin scope applied inside
 * `createResolveToolsCallback`. When a conversation has an `enabledPlugins`
 * set, only tools whose owning plugin id is in that set appear in the resolved
 * per-turn tool list; core tools are unaffected. `null` (no per-chat
 * restriction) leaves the list unchanged.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as configLoader from "../../config/loader.js";
import type { AssistantConfig } from "../../config/schema.js";
import type { ToolDefinition } from "../../providers/types.js";
import {
  __clearRegistryForTesting,
  registerPluginTools,
} from "../../tools/registry.js";
import type { Tool } from "../../tools/types.js";
import { createResolveToolsCallback } from "../conversation-tool-setup.js";

type SkillProjectionContext =
  import("../conversation-tool-setup.js").SkillProjectionContext;
type SkillProjectionCache =
  import("../conversation-skill-tools.js").SkillProjectionCache;

function def(name: string): ToolDefinition {
  return { name, description: name, input_schema: { type: "object" } };
}

function pluginTool(name: string): Tool {
  return {
    name,
    description: name,
    input_schema: def(name).input_schema,
  } as unknown as Tool;
}

function makeCtx(
  overrides: Partial<SkillProjectionContext> = {},
): SkillProjectionContext {
  return {
    skillProjectionState: new Map(),
    skillProjectionCache: { fingerprints: new Map() } as SkillProjectionCache,
    coreToolNames: new Set<string>(),
    toolsDisabledDepth: 0,
    ...overrides,
  };
}

let getConfigSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  __clearRegistryForTesting();
  // Resolver reads getConfig().tools.exclude; stub to an empty exclude so the
  // test isolates the plugin-scope filter.
  const stub: Partial<AssistantConfig> = { tools: { exclude: [] } };
  getConfigSpy = spyOn(configLoader, "getConfig").mockReturnValue(
    stub as AssistantConfig,
  );
});

afterEach(() => {
  getConfigSpy?.mockRestore();
  getConfigSpy = undefined;
  __clearRegistryForTesting();
});

describe("createResolveToolsCallback — per-chat plugin scope", () => {
  test("set {a} keeps plugin a's tools and core tools, drops plugin b's", () => {
    registerPluginTools("a", [pluginTool("a_tool")]);
    registerPluginTools("b", [pluginTool("b_tool")]);

    const resolver = createResolveToolsCallback(
      [def("file_read")],
      makeCtx({ enabledPlugins: ["a"] }),
    );
    const names = resolver!([]).map((d) => d.name);

    expect(names).toContain("a_tool");
    expect(names).toContain("file_read");
    expect(names).not.toContain("b_tool");
  });

  test("null scope leaves all plugin tools in the resolved list", () => {
    registerPluginTools("a", [pluginTool("a_tool")]);
    registerPluginTools("b", [pluginTool("b_tool")]);

    const resolver = createResolveToolsCallback(
      [def("file_read")],
      makeCtx({ enabledPlugins: null }),
    );
    const names = resolver!([]).map((d) => d.name);

    expect(names).toContain("a_tool");
    expect(names).toContain("b_tool");
    expect(names).toContain("file_read");
  });

  test("absent enabledPlugins behaves like null (no restriction)", () => {
    registerPluginTools("a", [pluginTool("a_tool")]);
    registerPluginTools("b", [pluginTool("b_tool")]);

    const resolver = createResolveToolsCallback([def("file_read")], makeCtx());
    const names = resolver!([]).map((d) => d.name);

    expect(names).toContain("a_tool");
    expect(names).toContain("b_tool");
  });

  test("empty scope drops every plugin tool but keeps core tools", () => {
    registerPluginTools("a", [pluginTool("a_tool")]);

    const resolver = createResolveToolsCallback(
      [def("file_read")],
      makeCtx({ enabledPlugins: [] }),
    );
    const names = resolver!([]).map((d) => d.name);

    expect(names).not.toContain("a_tool");
    expect(names).toContain("file_read");
  });
});
