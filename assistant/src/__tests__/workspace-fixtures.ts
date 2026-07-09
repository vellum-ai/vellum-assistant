/**
 * Per-test workspace fixture selection.
 *
 * The test preload seeds every test process's tmp workspace with the "migrated"
 * fixture — a pre-migrated set of the four assistant DBs — so a test that calls
 * `initializeDb()` opens an already-migrated DB and the migration runner no-ops
 * via its checkpoint ledger. That is the default (fixture "b").
 *
 * A test that needs an UNMIGRATED workspace (fixture "a") — e.g. to drive the
 * migration chain from scratch, or to assert first-boot behaviour — calls
 * `useEmptyWorkspace()` at the top of the file, before `initializeDb()`. It
 * drops the pre-copied DBs so the next `initializeDb()` runs the full chain
 * against an empty workspace.
 *
 * No source-module imports
 * ------------------------
 * Like the other `__tests__/` helpers, this file derives the DB directory from
 * `VELLUM_WORKSPACE_DIR` plus the known `data/db` layout rather than importing
 * `src/util/platform.js`, keeping it off the production import graph (see
 * `assistant/AGENTS.md`). The layout string is duplicated by design — the same
 * decoupling `removeTestDbFiles`/`assertNotLiveDb` already use.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";

import { assertNotLiveDb } from "./assert-not-live-db.js";

/**
 * Drop the pre-copied migrated DBs so this test file starts from an empty,
 * unmigrated workspace. Call it at the top of the file, before the first
 * `initializeDb()` / `getDb()`.
 */
export function useEmptyWorkspace(): void {
  const workspace = process.env.VELLUM_WORKSPACE_DIR;
  if (!workspace) {
    throw new Error(
      "useEmptyWorkspace: VELLUM_WORKSPACE_DIR is not set — the test preload did not run",
    );
  }
  const dbDir = join(workspace, "data", "db");
  // Belt to the preload-verifier's suspenders: never delete outside tmp.
  assertNotLiveDb(dbDir);
  rmSync(dbDir, { recursive: true, force: true });
}
