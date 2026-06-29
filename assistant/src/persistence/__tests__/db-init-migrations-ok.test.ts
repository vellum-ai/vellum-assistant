/**
 * Tests for initializeDb()'s readiness-gating return contract.
 *
 * The daemon's readiness latch (setDbReady) is gated on initializeDb resolving
 * with migrationsOk:true, so a clean init must report all migrations applied.
 * Migration-step failures are caught-and-logged inside the runner (not thrown),
 * so the boolean is the only signal lifecycle has to keep /readyz unready on a
 * partially-migrated schema — see assistant/src/daemon/lifecycle.ts.
 */

import { describe, expect, test } from "bun:test";

import { initializeDb } from "../db-init.js";

describe("initializeDb — migrationsOk return contract", () => {
  test("resolves to { migrationsOk: true } on a clean init", async () => {
    const result = await initializeDb();
    expect(result).toEqual({ migrationsOk: true });
  });
});
