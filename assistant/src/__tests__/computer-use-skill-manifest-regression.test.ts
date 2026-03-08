import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { RiskLevel } from "../permissions/types.js";
import { allComputerUseTools } from "../tools/computer-use/definitions.js";
import {
  __resetRegistryForTesting,
  getTool,
  initializeTools,
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
  test("manifest has exactly 12 tools", () => {
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

  test("all manifest tools have risk: low", () => {
    for (const tool of manifest.tools) {
      expect(tool.risk).toBe("low");
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
      const def = cuTool.getDefinition();
      const manifestTool = manifest.tools.find(
        (t: { name: string }) => t.name === def.name,
      );
      expect(manifestTool).toBeDefined();
      expect(manifestTool.description).toBe(def.description);
    }
  });

  test("manifest input_schema matches core definitions", async () => {
    await initializeTools();

    for (const cuTool of allComputerUseTools) {
      const def = cuTool.getDefinition();
      const manifestTool = manifest.tools.find(
        (t: { name: string }) => t.name === def.name,
      );
      expect(manifestTool).toBeDefined();
      expect(manifestTool.input_schema).toEqual(def.input_schema);
    }
  });

  test("CU action tools are not registered as core tools after initializeTools()", async () => {
    await initializeTools();

    // The 12 computer_use_* action tools must NOT be in the global registry
    // after initializeTools(). If they were, registerSkillTools() would skip
    // them as core tool collisions when the computer-use skill is activated.
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(getTool(name)).toBeUndefined();
    }
  });

  test("registerSkillTools succeeds for manifest tool names after initializeTools()", async () => {
    await initializeTools();

    // Simulate what projectSkillTools() does when the computer-use skill is
    // activated: create skill-origin Tool objects matching the manifest names
    // and register them. This must not throw.
    const skillTools: Tool[] = manifest.tools.map(
      (entry: { name: string; description: string }) => ({
        name: entry.name,
        description: entry.description,
        category: "computer-use",
        defaultRiskLevel: RiskLevel.Low,
        origin: "skill" as const,
        ownerSkillId: "computer-use",
        getDefinition: () => ({
          name: entry.name,
          description: entry.description,
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => ({ content: "stub", isError: false }),
      }),
    );

    expect(() => registerSkillTools(skillTools)).not.toThrow();

    // Clean up
    unregisterSkillTools("computer-use");
  });
});
