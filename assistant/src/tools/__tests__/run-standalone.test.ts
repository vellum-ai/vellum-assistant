/**
 * Tests for `runToolStandalone` in `run-standalone.ts`.
 *
 * Covers the lookup guard the runner owns: an unregistered tool name must
 * surface as an `UnknownToolError`. Successful dispatch is exercised end-to-end
 * by the executor's own test suite.
 */

import { describe, expect, test } from "bun:test";

import { runToolStandalone, UnknownToolError } from "../run-standalone.js";

describe("runToolStandalone", () => {
  test("throws UnknownToolError for an unregistered tool name", async () => {
    await expect(
      runToolStandalone("definitely_not_a_registered_tool_xyz", {}),
    ).rejects.toBeInstanceOf(UnknownToolError);
  });
});
