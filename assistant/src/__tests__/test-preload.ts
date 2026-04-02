/**
 * Shared test preload — runs before every test file.
 *
 * Creates a per-file temporary directory and sets VELLUM_WORKSPACE_DIR so that
 * all workspace-derived helpers (getDataDir, getDbPath, getConversationsDir, …)
 * resolve under the temp dir instead of the real ~/.vellum/workspace.
 *
 * Also redirects the encrypted credential store and credential metadata store
 * to the temp dir so that tests never read from or write to the real
 * ~/.vellum/protected/ directory. Without this, any test that calls
 * setSecureKeyAsync would mutate the developer's real credentials because
 * getProtectedDir() is not affected by VELLUM_WORKSPACE_DIR.
 *
 * Individual test files can retrieve the workspace dir via getWorkspaceDir()
 * from platform.ts, or directly from process.env.VELLUM_WORKSPACE_DIR.
 *
 * Cleanup: the temp dir is removed after all tests in the file complete.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

import { resetDb } from "../memory/db-connection.js";
import { _setStorePath } from "../security/encrypted-store.js";
import { _resetBackend } from "../security/secure-keys.js";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "vellum-test-workspace-")),
);
process.env.VELLUM_WORKSPACE_DIR = testDir;

const protectedDir = join(testDir, "protected");
mkdirSync(protectedDir, { recursive: true });
_setStorePath(join(protectedDir, "keys.enc"));

afterAll(() => {
  resetDb();
  _setStorePath(null);
  _resetBackend();
  delete process.env.VELLUM_WORKSPACE_DIR;
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
