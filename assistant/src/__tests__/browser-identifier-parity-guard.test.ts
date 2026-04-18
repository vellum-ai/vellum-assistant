/**
 * Parity guard for browser identifier sets.
 *
 * Verifies that three independently-consumed browser identifier sources
 * remain in sync:
 *
 *   1. Shared operation list        (BROWSER_OPERATIONS from browser/types.ts)
 *   2. Shared browser_* tool names  (BROWSER_TOOL_NAMES from browser/identifiers.ts)
 *   3. CLI subcommand registrations (BROWSER_OPERATION_META from browser/operations.ts)
 *
 * Drift between any of these causes silent mismatches between the CLI,
 * tool dispatch, and permission defaults. This guard catches additions
 * or removals in one source that aren't mirrored in the others.
 */

import { describe, expect, test } from "bun:test";

import { BROWSER_TOOL_NAMES } from "../browser/identifiers.js";
import { BROWSER_OPERATION_META } from "../browser/operations.js";
import { BROWSER_OPERATIONS } from "../browser/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function sorted(arr: readonly string[]): string[] {
  return [...arr].sort();
}

// ── Parity tests ─────────────────────────────────────────────────────

describe("browser identifier parity guard", () => {
  test("BROWSER_TOOL_NAMES matches BROWSER_OPERATIONS via browser_ prefix", () => {
    const derivedToolNames = BROWSER_OPERATIONS.map((op) => `browser_${op}`);
    expect(sorted(BROWSER_TOOL_NAMES)).toEqual(sorted(derivedToolNames));
  });

  test("CLI subcommand operations match BROWSER_OPERATIONS", () => {
    const metaOperations = BROWSER_OPERATION_META.map((m) => m.operation);
    expect(sorted(metaOperations)).toEqual(sorted(BROWSER_OPERATIONS));
  });

  test("all three sources agree on the same count", () => {
    const metaOperations = BROWSER_OPERATION_META.map((m) => m.operation);

    const counts = {
      BROWSER_OPERATIONS: BROWSER_OPERATIONS.length,
      BROWSER_TOOL_NAMES: BROWSER_TOOL_NAMES.length,
      BROWSER_OPERATION_META: metaOperations.length,
    };

    // All counts must be identical.
    const uniqueCounts = new Set(Object.values(counts));
    expect(uniqueCounts.size).toBe(1);
  });
});
