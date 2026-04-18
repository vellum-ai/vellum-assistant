/**
 * Parity guard for browser operation and CLI subcommand identifiers.
 *
 * Verifies that the canonical operation list and CLI subcommand
 * metadata remain in sync:
 *
 *   1. Shared operation list     (BROWSER_OPERATIONS from browser/types.ts)
 *   2. CLI subcommand metadata   (BROWSER_OPERATION_META from browser/operations.ts)
 *
 * Drift between these causes silent mismatches between the CLI and
 * operation dispatch. This guard catches additions or removals in
 * one source that aren't mirrored in the other.
 */

import { describe, expect, test } from "bun:test";

import { BROWSER_OPERATION_META } from "../browser/operations.js";
import { BROWSER_OPERATIONS } from "../browser/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function sorted(arr: readonly string[]): string[] {
  return [...arr].sort();
}

// ── Parity tests ─────────────────────────────────────────────────────

describe("browser CLI/operation parity guard", () => {
  test("CLI subcommand operations match BROWSER_OPERATIONS", () => {
    const metaOperations = BROWSER_OPERATION_META.map((m) => m.operation);
    expect(sorted(metaOperations)).toEqual(sorted(BROWSER_OPERATIONS));
  });

  test("both sources agree on the same count", () => {
    const metaOperations = BROWSER_OPERATION_META.map((m) => m.operation);

    const counts = {
      BROWSER_OPERATIONS: BROWSER_OPERATIONS.length,
      BROWSER_OPERATION_META: metaOperations.length,
    };

    // All counts must be identical.
    const uniqueCounts = new Set(Object.values(counts));
    expect(uniqueCounts.size).toBe(1);
  });

  test("every CLI subcommand has a help text referencing the assistant browser command", () => {
    for (const meta of BROWSER_OPERATION_META) {
      expect(meta.helpText).toBeDefined();
      expect(meta.helpText).toContain("assistant browser");
    }
  });
});
