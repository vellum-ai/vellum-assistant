/**
 * Parity guard for browser identifier sets.
 *
 * Verifies that four independently-consumed browser identifier sources
 * remain in sync:
 *
 *   1. Shared operation list        (BROWSER_OPERATIONS from browser/types.ts)
 *   2. Shared browser_* tool names  (BROWSER_TOOL_NAMES from browser/operations.ts)
 *   3. TOOLS.json tool names        (browser skill manifest)
 *   4. CLI subcommand registrations (BROWSER_OPERATION_META from browser/operations.ts)
 *
 * Drift between any of these causes silent mismatches between the CLI,
 * tool dispatch, permission defaults, and skill manifest. This guard
 * catches additions or removals in one source that aren't mirrored in
 * the others.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  BROWSER_OPERATION_META,
  BROWSER_TOOL_NAMES,
} from "../browser/operations.js";
import { BROWSER_OPERATIONS } from "../browser/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function sorted(arr: readonly string[]): string[] {
  return [...arr].sort();
}

const TOOLS_JSON_PATH = resolve(
  __dirname,
  "../config/bundled-skills/browser/TOOLS.json",
);

function readToolsJsonNames(): string[] {
  const raw = readFileSync(TOOLS_JSON_PATH, "utf-8");
  const manifest = JSON.parse(raw) as {
    tools: Array<{ name: string }>;
  };
  return manifest.tools.map((t) => t.name);
}

// ── Parity tests ─────────────────────────────────────────────────────

describe("browser identifier parity guard", () => {
  test("BROWSER_TOOL_NAMES matches BROWSER_OPERATIONS via browser_ prefix", () => {
    const derivedToolNames = BROWSER_OPERATIONS.map((op) => `browser_${op}`);
    expect(sorted(BROWSER_TOOL_NAMES)).toEqual(sorted(derivedToolNames));
  });

  test("TOOLS.json tool names match BROWSER_TOOL_NAMES", () => {
    const toolsJsonNames = readToolsJsonNames();
    expect(sorted(toolsJsonNames)).toEqual(sorted(BROWSER_TOOL_NAMES));
  });

  test("CLI subcommand operations match BROWSER_OPERATIONS", () => {
    const metaOperations = BROWSER_OPERATION_META.map((m) => m.operation);
    expect(sorted(metaOperations)).toEqual(sorted(BROWSER_OPERATIONS));
  });

  test("all four sources agree on the same count", () => {
    const toolsJsonNames = readToolsJsonNames();
    const metaOperations = BROWSER_OPERATION_META.map((m) => m.operation);

    const counts = {
      BROWSER_OPERATIONS: BROWSER_OPERATIONS.length,
      BROWSER_TOOL_NAMES: BROWSER_TOOL_NAMES.length,
      TOOLS_JSON: toolsJsonNames.length,
      BROWSER_OPERATION_META: metaOperations.length,
    };

    // All counts must be identical.
    const uniqueCounts = new Set(Object.values(counts));
    expect(uniqueCounts.size).toBe(1);
  });
});
