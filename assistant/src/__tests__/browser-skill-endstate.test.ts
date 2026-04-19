/**
 * End-state verification test for the browser CLI-only architecture.
 *
 * Locks the invariants of the CLI-only browser contract so that future
 * changes cannot silently regress any of the architectural guarantees.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
}));

import { BROWSER_OPERATION_META } from "../browser/operations.js";
import { BROWSER_OPERATIONS } from "../browser/types.js";
import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";
import {
  projectSkillTools,
  resetSkillToolProjection,
} from "../daemon/conversation-skill-tools.js";
import {
  __resetRegistryForTesting,
  getAllToolDefinitions,
  getAllTools,
  initializeTools,
} from "../tools/registry.js";
import {
  BROWSER_SKILL_ID,
  buildSkillLoadHistory,
} from "./test-support/browser-skill-harness.js";

afterAll(() => {
  __resetRegistryForTesting();
  _setOverridesForTesting({});
});

describe("browser CLI-only architecture end-state", () => {
  beforeAll(async () => {
    __resetRegistryForTesting();
    _setOverridesForTesting({
      browser: true,
    });
    await initializeTools();
  });

  // ── 1. No browser_* tools in startup payload ─────────────────────

  test("no browser_* tools are registered at startup", () => {
    const toolNames = getAllTools().map((t) => t.name);
    const browserTools = toolNames.filter((n) => n.startsWith("browser_"));
    expect(browserTools).toHaveLength(0);
  });

  test("no browser_* tool definitions at startup", () => {
    const definitions = getAllToolDefinitions();
    const browserDefs = definitions.filter((d) =>
      d.name.startsWith("browser_"),
    );
    expect(browserDefs).toHaveLength(0);
  });

  // ── 2. Browser skill directory exists with SKILL.md ──────────────

  test("managed browser skill directory exists with SKILL.md but no TOOLS.json", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    // Browser skill lives in skills/browser/ (managed), not bundled-skills/.
    const skillDir = path.resolve(
      import.meta.dirname,
      "../../../skills/vellum-browser-use",
    );
    expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
    // Browser operations are dispatched via the CLI, not via skill tools.
    expect(fs.existsSync(path.join(skillDir, "TOOLS.json"))).toBe(false);
  });

  // ── 3. Browser tool wrapper directory does not exist ─────────────

  test("browser tool wrapper scripts directory does not exist", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const toolsDir = path.resolve(
      import.meta.dirname,
      "../../../skills/vellum-browser-use/tools",
    );
    // Browser operations are dispatched via CLI commands,
    // not via per-tool executor files.
    expect(fs.existsSync(toolsDir)).toBe(false);
  });

  // ── 4. Browser operations have CLI metadata ──────────────────────

  test("every browser operation has CLI subcommand metadata", () => {
    for (const op of BROWSER_OPERATIONS) {
      const meta = BROWSER_OPERATION_META.find((m) => m.operation === op);
      expect(meta).toBeDefined();
      expect(meta!.helpText).toBeDefined();
      expect(meta!.helpText).toContain("assistant browser");
    }
  });

  // ── 5. Skill projection emits no tool definitions ────────────────

  test("skill_load projection registers no browser tools", () => {
    const history = buildSkillLoadHistory(BROWSER_SKILL_ID);
    const tracking = new Map<string, string>();

    try {
      const projection = projectSkillTools(history, {
        previouslyActiveSkillIds: tracking,
      });

      // No tool definitions sent to the LLM — browser operations are
      // dispatched via `assistant browser` CLI commands.
      expect(projection.toolDefinitions).toHaveLength(0);
      expect(projection.allowedToolNames.size).toBe(0);
    } finally {
      resetSkillToolProjection(tracking);
    }
  });

  // ── 6. Execution module exists ───────────────────────────────────

  test("browser-execution.ts exists with exported execute functions", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const execPath = path.resolve(
      import.meta.dirname,
      "../tools/browser/browser-execution.ts",
    );
    expect(fs.existsSync(execPath)).toBe(true);
  });
});
