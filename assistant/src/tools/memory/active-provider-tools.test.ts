/**
 * Tests for `getMemoryToolsForActiveProvider()` — the manifest accessor that
 * sources the `remember`/`recall` tools from the active memory provider's
 * `provideTools()`. `initializeTools()` registers exactly this set, so the
 * accessor is the seam that decides which memory tools exist per
 * `memory.provider`:
 *
 * - graph / v2 / v3 expose `remember` + `recall` (the executable tools whose
 *   schemas mirror the canonical graph definitions),
 * - `none` exposes nothing.
 *
 * The provider modules are not mocked — the real graph/v2/v3 providers all
 * resolve to the shared `rememberTool`/`recallTool`, and `none` resolves to
 * empty; that sharing is exactly what this test pins.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as configLoader from "../../config/loader.js";
import { AssistantConfigSchema } from "../../config/schema.js";
import {
  graphRecallDefinition,
  graphRememberDefinition,
} from "../../memory/graph/tools.js";
import { getMemoryToolsForActiveProvider } from "../tool-manifest.js";

afterEach(() => {
  spyOn(configLoader, "getConfig").mockRestore();
});

/**
 * Run `getMemoryToolsForActiveProvider()` with `getConfig()` pinned to a config
 * whose `memory.provider` is `provider`.
 */
function memoryToolsFor(provider: string) {
  const config = AssistantConfigSchema.parse({ memory: { provider } });
  spyOn(configLoader, "getConfig").mockReturnValue(config);
  return getMemoryToolsForActiveProvider();
}

describe("getMemoryToolsForActiveProvider", () => {
  test.each(["graph", "v2", "v3"] as const)(
    'provider "%s" exposes remember + recall',
    (provider) => {
      const names = memoryToolsFor(provider)
        .map((t) => t.name)
        .sort();
      expect(names).toEqual(["recall", "remember"]);
    },
  );

  test('provider "none" exposes no memory tools', () => {
    expect(memoryToolsFor("none")).toEqual([]);
  });

  test("registered tool schemas match the canonical graph definitions", () => {
    const tools = memoryToolsFor("graph");
    const remember = tools.find((t) => t.name === "remember");
    const recall = tools.find((t) => t.name === "recall");

    expect(remember?.description).toBe(graphRememberDefinition.description);
    expect(remember?.input_schema).toEqual(
      graphRememberDefinition.input_schema,
    );
    expect(recall?.description).toBe(graphRecallDefinition.description);
    expect(recall?.input_schema).toEqual(graphRecallDefinition.input_schema);
  });

  test("graph, v2, and v3 register the same executable tool instances", () => {
    const graphTools = memoryToolsFor("graph");
    const v2Tools = memoryToolsFor("v2");
    const v3Tools = memoryToolsFor("v3");

    // All three providers contribute the shared `rememberTool`/`recallTool`
    // instances — the same objects carrying the real `execute` handlers.
    expect(graphTools).toEqual(v2Tools);
    expect(v3Tools).toEqual(v2Tools);
    for (const tool of graphTools) {
      expect(typeof tool.execute).toBe("function");
    }
  });
});
