import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { RiskLevel } from "../permissions/types.js";
import { allComputerUseTools } from "../tools/computer-use/definitions.js";
import {
  __resetRegistryForTesting,
  initializeTools,
  peekTool,
  registerSkillTools,
  unregisterSkillTools,
} from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import {
  COMPUTER_USE_TOOL_COUNT,
  COMPUTER_USE_TOOL_NAMES,
} from "./test-support/computer-use-skill-harness.js";

afterAll(() => {
  __resetRegistryForTesting();
});

// Load the TOOLS.json manifest
const manifestPath = resolve(
  import.meta.dirname,
  "../config/bundled-skills/computer-use/TOOLS.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

describe("computer-use skill manifest regression", () => {
  test("manifest has exactly 11 tools", () => {
    expect(manifest.tools).toHaveLength(COMPUTER_USE_TOOL_COUNT);
  });

  test("manifest version is 1", () => {
    expect(manifest.version).toBe(1);
  });

  test("manifest tool names match harness constants", () => {
    const manifestNames = manifest.tools.map((t: { name: string }) => t.name);
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(manifestNames).toContain(name);
    }
    // No extra tools
    expect(manifestNames).toHaveLength(COMPUTER_USE_TOOL_COUNT);
  });

  test("all manifest tools have execution_target: host", () => {
    for (const tool of manifest.tools) {
      expect(tool.execution_target).toBe("host");
    }
  });

  test("read-only tools have risk: low, side-effect tools have risk: medium", () => {
    const readOnlyTools = new Set([
      "computer_use_observe",
      "computer_use_wait",
      "computer_use_done",
      "computer_use_respond",
    ]);
    for (const tool of manifest.tools) {
      if (readOnlyTools.has(tool.name)) {
        expect(tool.risk).toBe("low");
      } else {
        expect(tool.risk).toBe("medium");
      }
    }
  });

  test("all manifest tools have category: computer-use", () => {
    for (const tool of manifest.tools) {
      expect(tool.category).toBe("computer-use");
    }
  });

  test("manifest descriptions match core definitions", async () => {
    await initializeTools();

    for (const cuTool of allComputerUseTools) {
      const manifestTool = manifest.tools.find(
        (t: { name: string }) => t.name === cuTool.name,
      );
      expect(manifestTool).toBeDefined();
      expect(manifestTool.description).toBe(cuTool.description);
    }
  });

  test("manifest input_schema matches core definitions", async () => {
    await initializeTools();

    for (const cuTool of allComputerUseTools) {
      const manifestTool = manifest.tools.find(
        (t: { name: string }) => t.name === cuTool.name,
      );
      expect(manifestTool).toBeDefined();
      expect(manifestTool.input_schema).toEqual(cuTool.input_schema);
    }
  });

  test("CU action tools are not registered as core tools after initializeTools()", async () => {
    await initializeTools();

    // The 12 computer_use_* action tools must NOT be in the global registry
    // after initializeTools(). If they were, registerSkillTools() would skip
    // them as core tool collisions when the computer-use skill is activated.
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(peekTool(name)).toBeUndefined();
    }
  });

  test("registerSkillTools succeeds for manifest tool names after initializeTools()", async () => {
    await initializeTools();

    // Simulate what projectSkillTools() does when the computer-use skill is
    // activated: create Tool objects matching the manifest names and register
    // them through `registerSkillTools(skillId, tools)`, which records
    // ownership in the registry's `ownersByName` map. This must not throw.
    const skillTools: Tool[] = manifest.tools.map(
      (entry: { name: string; description: string }) => ({
        name: entry.name,
        description: entry.description,
        input_schema: { type: "object" as const, properties: {} },
        category: "computer-use",
        defaultRiskLevel: RiskLevel.Low,
        execute: async () => ({ content: "stub", isError: false }),
      }),
    );

    // Owner flows in through `registerSkillTools(skillId, tools)` and lands
    // in the registry's `ownersByName` map — the tools themselves carry no
    // per-tool owner field.
    expect(() => registerSkillTools("computer-use", skillTools)).not.toThrow();

    // Clean up
    unregisterSkillTools("computer-use");
  });
});
