/**
 * Tests for {@link readRegisteredPluginSurfaces}.
 *
 * The helper reads the daemon's two in-memory registries (plugin registry for
 * hooks, tool registry for tools), so the fixtures register real plugins and
 * plugin tools and assert the snapshot reflects only what is live and only
 * what belongs to the named plugin.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { RiskLevel } from "../../permissions/types.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../../plugins/registry.js";
import type { Plugin, PluginHooks } from "../../plugins/types.js";
import {
  __resetRegistryForTesting,
  registerPluginTools,
} from "../../tools/registry.js";
import type {
  Tool,
  ToolContext,
  ToolExecutionResult,
} from "../../tools/types.js";
import { readRegisteredPluginSurfaces } from "../registered-plugin-surfaces.js";

afterAll(() => {
  __resetRegistryForTesting();
  resetPluginRegistryForTests();
});

beforeEach(() => {
  __resetRegistryForTesting();
  resetPluginRegistryForTests();
});

afterEach(() => {
  __resetRegistryForTesting();
  resetPluginRegistryForTests();
});

function makeTool(name: string): Tool {
  return {
    name,
    description: `Fake ${name}`,
    category: "test",
    defaultRiskLevel: RiskLevel.Low,
    executionTarget: "sandbox",
    input_schema: { type: "object", properties: {}, required: [] },
    async execute(
      _input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolExecutionResult> {
      return { content: "ok", isError: false };
    },
  };
}

function makePlugin(name: string, hookNames: string[]): Plugin {
  const hooks: PluginHooks = {};
  for (const hook of hookNames) hooks[hook] = async () => {};
  return { manifest: { name, version: "0.1.0" }, hooks };
}

describe("readRegisteredPluginSurfaces", () => {
  test("reports the plugin's registered hooks and tools, sorted", () => {
    // GIVEN a plugin registered with two hooks and two tools
    registerPlugin(makePlugin("level-up", ["init", "pre-model-call"]));
    registerPluginTools("level-up", [
      makeTool("summarize"),
      makeTool("expand"),
    ]);

    // WHEN its live surfaces are read
    const surfaces = readRegisteredPluginSurfaces("level-up");

    // THEN both lists reflect the registries, sorted
    expect(surfaces.hooks).toEqual(["init", "pre-model-call"]);
    expect(surfaces.tools).toEqual(["expand", "summarize"]);
  });

  test("includes only tools owned by the named plugin", () => {
    // GIVEN two plugins each contributing a tool
    registerPlugin(makePlugin("level-up", []));
    registerPlugin(makePlugin("other", []));
    registerPluginTools("level-up", [makeTool("summarize")]);
    registerPluginTools("other", [makeTool("translate")]);

    // WHEN one plugin's surfaces are read
    const surfaces = readRegisteredPluginSurfaces("level-up");

    // THEN the other plugin's tool is excluded
    expect(surfaces.tools).toEqual(["summarize"]);
  });

  test("returns empty arrays for a plugin that is not registered", () => {
    // GIVEN nothing registered under this name
    // WHEN its live surfaces are read
    const surfaces = readRegisteredPluginSurfaces("ghost");

    // THEN the answer is "nothing live", not an error
    expect(surfaces).toEqual({ hooks: [], tools: [] });
  });
});
