/**
 * End-state verification test for the browser skill migration.
 *
 * Locks the final invariants from the BROWSER_SKILL plan so that future
 * changes cannot silently regress any of the migration guarantees.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
}));

import { BROWSER_TOOL_NAMES } from "../browser/operations.js";
import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";
import {
  projectSkillTools,
  resetSkillToolProjection,
} from "../daemon/conversation-skill-tools.js";
import { getDefaultRuleTemplates } from "../permissions/defaults.js";
import {
  __resetRegistryForTesting,
  getAllToolDefinitions,
  getAllTools,
  initializeTools,
} from "../tools/registry.js";
import { eagerModuleToolNames } from "../tools/tool-manifest.js";
import {
  BROWSER_SKILL_ID,
  BROWSER_TOOL_COUNT,
  buildSkillLoadHistory,
} from "./test-support/browser-skill-harness.js";

afterAll(() => {
  __resetRegistryForTesting();
  _setOverridesForTesting({});
});

describe("browser skill migration end-state", () => {
  beforeAll(async () => {
    __resetRegistryForTesting();
    _setOverridesForTesting({
      browser: true,
    });
    await initializeTools();
  });

  // Browser tool names sourced from the shared browser operations contract
  // (BROWSER_TOOL_NAMES) — no independent list maintained here.

  // ── 1. Startup payload excludes browser tools ──────────────────────

  test("browser tools are NOT in startup core registry", () => {
    const toolNames = getAllTools().map((t) => t.name);
    for (const name of BROWSER_TOOL_NAMES) {
      expect(toolNames).not.toContain(name);
    }
  });

  test("browser tool names are NOT in eagerModuleToolNames", () => {
    for (const name of BROWSER_TOOL_NAMES) {
      expect(eagerModuleToolNames).not.toContain(name);
    }
  });

  test("startup tool definition count is reduced (no browser tools)", () => {
    const definitions = getAllToolDefinitions();
    // Startup has ~20 definitions after moving scaffold/settings/skill-management
    // tools to bundled skills (no browser tools).
    // Allow wider drift for unrelated tool additions while still failing if
    // browser tools are reintroduced at startup (+many definitions).
    expect(definitions.length).toBeGreaterThanOrEqual(15);
    expect(definitions.length).toBeLessThanOrEqual(50);

    const defNames = definitions.map((d) => d.name);
    for (const name of BROWSER_TOOL_NAMES) {
      expect(defNames).not.toContain(name);
    }

    // Payload ceiling: startup payload is ~22 000 chars.  Browser tools
    // contribute ~4 640 chars — if they leak back in, the total would exceed
    // 35 000.  The margin absorbs minor tool additions.
    const payloadSize = JSON.stringify(definitions).length;
    expect(payloadSize).toBeLessThan(35_000);
  });

  // ── 2. Browser skill exists and is active ──────────────────────────

  test("bundled browser skill directory exists with SKILL.md and TOOLS.json", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const skillDir = path.resolve(
      import.meta.dirname,
      "../config/bundled-skills/browser",
    );
    expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, "TOOLS.json"))).toBe(true);
  });

  test("browser TOOLS.json contains all browser tools", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const toolsPath = path.resolve(
      import.meta.dirname,
      "../config/bundled-skills/browser/TOOLS.json",
    );
    const manifest = JSON.parse(fs.readFileSync(toolsPath, "utf-8"));
    expect(manifest.version).toBe(1);
    expect(manifest.tools).toHaveLength(BROWSER_TOOL_NAMES.length);
    const toolNames = manifest.tools.map((t: { name: string }) => t.name);
    for (const name of BROWSER_TOOL_NAMES) {
      expect(toolNames).toContain(name);
    }
  });

  test("every browser tool schema exposes an optional browser_mode property", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const toolsPath = path.resolve(
      import.meta.dirname,
      "../config/bundled-skills/browser/TOOLS.json",
    );
    const manifest = JSON.parse(fs.readFileSync(toolsPath, "utf-8"));
    for (const tool of manifest.tools) {
      const props = tool.input_schema?.properties ?? {};
      expect(props.browser_mode).toBeDefined();
      expect(props.browser_mode.type).toBe("string");
      // browser_mode must NOT be required
      const required: string[] = tool.input_schema?.required ?? [];
      expect(required).not.toContain("browser_mode");
    }
  });

  // ── 3. Permission defaults align with PR 08/09 ────────────────────

  test("skill_load has default allow rule", () => {
    const templates = getDefaultRuleTemplates();
    const rule = templates.find(
      (t) => t.id === "default:allow-skill_load-global",
    );
    expect(rule).toBeDefined();
    expect(rule!.decision).toBe("allow");
  });

  test("all browser tools have default allow rules", () => {
    const templates = getDefaultRuleTemplates();
    for (const tool of BROWSER_TOOL_NAMES) {
      const rule = templates.find(
        (t) => t.id === `default:allow-${tool}-global`,
      );
      expect(rule).toBeDefined();
      expect(rule!.decision).toBe("allow");
      // browser_navigate uses standalone "**" globstar because navigate
      // candidates contain URLs with "/" (e.g. "browser_navigate:https://example.com/path").
      const expectedPattern = tool === "browser_navigate" ? "**" : `${tool}:*`;
      expect(rule!.pattern).toBe(expectedPattern);
    }
  });

  // ── 4. Tool wrapper scripts exist ──────────────────────────────────

  test("all browser tool wrapper scripts exist", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const toolsDir = path.resolve(
      import.meta.dirname,
      "../config/bundled-skills/browser/tools",
    );
    const wrapperFiles = [
      "browser-navigate.ts",
      "browser-snapshot.ts",
      "browser-screenshot.ts",
      "browser-close.ts",
      "browser-attach.ts",
      "browser-detach.ts",
      "browser-click.ts",
      "browser-type.ts",
      "browser-press-key.ts",
      "browser-scroll.ts",
      "browser-select-option.ts",
      "browser-hover.ts",
      "browser-wait-for.ts",
      "browser-extract.ts",
      "browser-wait-for-download.ts",
      "browser-fill-credential.ts",
      "browser-status.ts",
    ];
    for (const file of wrapperFiles) {
      expect(fs.existsSync(path.join(toolsDir, file))).toBe(true);
    }
  });

  // ── 5. Execution extraction is in place ────────────────────────────

  test("browser-execution.ts exists with exported execute functions", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const execPath = path.resolve(
      import.meta.dirname,
      "../tools/browser/browser-execution.ts",
    );
    expect(fs.existsSync(execPath)).toBe(true);
    const content = fs.readFileSync(execPath, "utf-8");
    // browser_wait_for_download has no matching executeBrowser* function
    // exported from browser-execution.ts — it is handled via operations.ts.
    const TOOLS_WITH_EXECUTE_FN = BROWSER_TOOL_NAMES.filter(
      (name) => name !== "browser_wait_for_download",
    );
    for (const name of TOOLS_WITH_EXECUTE_FN) {
      // Derive expected function name: browser_navigate -> executeBrowserNavigate
      const fnName =
        "execute" +
        name
          .split("_")
          .map((s, i) =>
            i === 0 ? "Browser" : s.charAt(0).toUpperCase() + s.slice(1),
          )
          .join("");
      expect(content).toContain(fnName);
    }
  });

  // ── 6. Runtime projection adds all browser tools ──────────

  test("skill_load projection adds all browser tools", () => {
    const history = buildSkillLoadHistory(BROWSER_SKILL_ID);
    const tracking = new Map<string, string>();

    try {
      const projection = projectSkillTools(history, {
        previouslyActiveSkillIds: tracking,
      });

      // Tool definitions are no longer sent to the LLM (dispatched via
      // skill_execute), so toolDefinitions is expected to be empty.
      expect(projection.toolDefinitions).toHaveLength(0);

      // All browser tools should be registered and tracked in allowedToolNames
      expect(projection.allowedToolNames.size).toBe(BROWSER_TOOL_COUNT);
      for (const name of BROWSER_TOOL_NAMES) {
        expect(projection.allowedToolNames.has(name)).toBe(true);
      }
    } finally {
      resetSkillToolProjection(tracking);
    }
  });
});
