import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";

import { buildToolDefinitions } from "../daemon/session-tool-setup.js";
import { getBundledSkillsDir } from "../skills/catalog.js";
import { parseToolManifestFile } from "../skills/tool-manifest.js";
import {
  __resetRegistryForTesting,
  getAllToolDefinitions,
  getAllTools,
  getTool,
  initializeTools,
} from "../tools/registry.js";
import {
  COMPUTER_USE_TOOL_COUNT,
  COMPUTER_USE_TOOL_NAMES,
} from "./test-support/computer-use-skill-harness.js";

beforeAll(async () => {
  __resetRegistryForTesting();
  await initializeTools();
});

describe("computer-use skill end-state", () => {
  // ── Core Registry ──────────────────────────────────────────────────

  test("core registry contains 1 computer_use_* tool (escalation only)", () => {
    const allTools = getAllTools();
    const cuTools = allTools.filter((t) => t.name.startsWith("computer_use_"));
    expect(cuTools).toHaveLength(1);
    expect(cuTools[0].name).toBe("computer_use_request_control");
  });

  test("computer_use_request_control is resolvable from core registry", () => {
    expect(getTool("computer_use_request_control")).toBeDefined();
  });

  test("no action tool from COMPUTER_USE_TOOL_NAMES is resolvable from core registry", () => {
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(getTool(name)).toBeUndefined();
    }
  });

  // ── getAllToolDefinitions (excludes proxy & skill tools) ──────────

  test("getAllToolDefinitions() excludes computer_use_* tools", () => {
    const defs = getAllToolDefinitions();
    const cuDefs = defs.filter((d) => d.name.startsWith("computer_use_"));
    expect(cuDefs).toHaveLength(0);
  });

  test("getAllToolDefinitions() excludes computer_use_request_control (proxy exclusion)", () => {
    const defs = getAllToolDefinitions();
    const found = defs.find((d) => d.name === "computer_use_request_control");
    expect(found).toBeUndefined();
  });

  // ── buildToolDefinitions (text session tool set) ─────────────────

  test("buildToolDefinitions() includes computer_use_request_control", () => {
    const defs = buildToolDefinitions();
    const found = defs.find((d) => d.name === "computer_use_request_control");
    expect(found).toBeDefined();
  });

  test("buildToolDefinitions() excludes computer_use_* action tools", () => {
    const defs = buildToolDefinitions();
    const cuDefs = defs.filter(
      (d) =>
        d.name.startsWith("computer_use_") &&
        d.name !== "computer_use_request_control",
    );
    expect(cuDefs).toHaveLength(0);
  });

  // ── Bundled Skill Catalog ────────────────────────────────────────

  test(
    "computer-use skill has exactly " +
      COMPUTER_USE_TOOL_COUNT +
      " tools in TOOLS.json",
    () => {
      const manifestPath = join(
        getBundledSkillsDir(),
        "computer-use",
        "TOOLS.json",
      );
      const manifest = parseToolManifestFile(manifestPath);
      expect(manifest.tools).toHaveLength(COMPUTER_USE_TOOL_COUNT);
    },
  );

  test("bundled skill tool names match expected computer_use_* names", () => {
    const manifestPath = join(
      getBundledSkillsDir(),
      "computer-use",
      "TOOLS.json",
    );
    const manifest = parseToolManifestFile(manifestPath);
    const toolNames = new Set(manifest.tools.map((t) => t.name));
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(toolNames.has(name)).toBe(true);
    }
  });
});
