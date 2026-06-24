/**
 * Tests for the `config.tools.exclude` filter applied inside
 * `createResolveToolsCallback`. Excluded tool names must not appear in the
 * tool list resolved per turn, nor in the executor's `allowedToolNames`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as configLoader from "../../config/loader.js";
import type { AssistantConfig } from "../../config/schema.js";
import type { ToolDefinition } from "../../providers/types.js";
import {
  __clearRegistryForTesting,
  registerMcpTools,
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

function mcpTool(name: string): Tool {
  return {
    name,
    description: name,
    input_schema: def(name).input_schema,
  } as unknown as Tool;
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

function withExclude(exclude: string[]) {
  const stub: Partial<AssistantConfig> = { tools: { exclude } };
  return spyOn(configLoader, "getConfig").mockReturnValue(
    stub as AssistantConfig,
  );
}

let getConfigSpy: ReturnType<typeof withExclude> | undefined;

beforeEach(() => {
  __clearRegistryForTesting();
});

afterEach(() => {
  getConfigSpy?.mockRestore();
  getConfigSpy = undefined;
  __clearRegistryForTesting();
});

describe("createResolveToolsCallback — config.tools.exclude", () => {
  test("excluded core tool is omitted from the resolved tool list", () => {
    getConfigSpy = withExclude(["bash"]);
    const resolver = createResolveToolsCallback(
      [def("bash"), def("file_read")],
      makeCtx(),
    );
    const result = resolver!([]);
    expect(result.map((d) => d.name)).toEqual(["file_read"]);
  });

  test("excluded core tool is removed from ctx.allowedToolNames", () => {
    getConfigSpy = withExclude(["bash"]);
    const ctx = makeCtx();
    const resolver = createResolveToolsCallback(
      [def("bash"), def("file_read")],
      ctx,
    );
    resolver!([]);
    expect(ctx.allowedToolNames?.has("bash")).toBe(false);
    expect(ctx.allowedToolNames?.has("file_read")).toBe(true);
  });

  test("excluded MCP tool is omitted from the resolved tool list", () => {
    registerMcpTools("test-server", [
      mcpTool("mcp__server__navigate"),
      mcpTool("mcp__server__click"),
    ]);
    getConfigSpy = withExclude(["mcp__server__navigate"]);
    const resolver = createResolveToolsCallback(
      [def("mcp__server__navigate"), def("mcp__server__click")],
      makeCtx(),
    );
    const result = resolver!([]);
    expect(result.map((d) => d.name)).toEqual(["mcp__server__click"]);
  });

  test("unknown name in exclude list is silently ignored", () => {
    getConfigSpy = withExclude(["does_not_exist"]);
    const resolver = createResolveToolsCallback([def("file_read")], makeCtx());
    expect(() => resolver!([])).not.toThrow();
    expect(resolver!([]).map((d) => d.name)).toEqual(["file_read"]);
  });

  test("empty exclude list leaves the tool set unchanged", () => {
    getConfigSpy = withExclude([]);
    const resolver = createResolveToolsCallback(
      [def("bash"), def("file_read")],
      makeCtx(),
    );
    expect(
      resolver!([])
        .map((d) => d.name)
        .sort(),
    ).toEqual(["bash", "file_read"]);
  });

  test("memory.enabled=false hides remember but keeps recall available", () => {
    const stub: Partial<AssistantConfig> = {
      memory: { enabled: false } as AssistantConfig["memory"],
      tools: { exclude: [] },
    };
    getConfigSpy = spyOn(configLoader, "getConfig").mockReturnValue(
      stub as AssistantConfig,
    );
    const resolver = createResolveToolsCallback(
      [def("remember"), def("recall"), def("file_read")],
      makeCtx(),
    );

    const names = resolver!([]).map((d) => d.name);

    expect(names).toEqual(["recall", "file_read"]);
  });

  test("plugin tool registered after resolver creation is picked up next turn", () => {
    getConfigSpy = withExclude([]);
    // Resolver created when only a core tool exists — no plugin yet, mirroring
    // a conversation that started before the plugin was installed.
    const resolver = createResolveToolsCallback([def("file_read")], makeCtx());
    expect(resolver!([]).map((d) => d.name)).toEqual(["file_read"]);

    // A plugin installed + activated mid-conversation lands its tool in the
    // registry. The resolver must surface it on the next turn without the
    // conversation being recreated (the plugin equivalent of `mcp reload`).
    registerPluginTools("late-plugin", [pluginTool("admin_copilot_prefs")]);
    const names = resolver!([]).map((d) => d.name);
    expect(names).toContain("admin_copilot_prefs");
    expect(names).toContain("file_read");
  });

  test("excluded plugin tool is omitted from the resolved tool list", () => {
    registerPluginTools("ex-plugin", [pluginTool("ex_plugin_tool")]);
    getConfigSpy = withExclude(["ex_plugin_tool"]);
    const resolver = createResolveToolsCallback(
      [def("file_read"), def("ex_plugin_tool")],
      makeCtx(),
    );
    expect(resolver!([]).map((d) => d.name)).toEqual(["file_read"]);
  });

  test("excluded tool stays excluded under disk-pressure cleanup mode", () => {
    // `bash` is a cleanup-safe tool and would normally survive cleanup mode;
    // the exclude filter must still suppress it.
    getConfigSpy = withExclude(["bash"]);
    const ctx = makeCtx({ diskPressureCleanupModeActive: true });
    const resolver = createResolveToolsCallback(
      [def("bash"), def("file_read")],
      ctx,
    );
    const result = resolver!([]);
    expect(result.map((d) => d.name)).not.toContain("bash");
    expect(ctx.allowedToolNames?.has("bash")).toBe(false);
  });
});
