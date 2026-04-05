/**
 * Shared test preload — runs before every test file.
 *
 * Creates a per-file temporary directory and sets VELLUM_WORKSPACE_DIR so that
 * all workspace-derived helpers (getDataDir, getDbPath, getConversationsDir, …)
 * resolve under the temp dir instead of the real ~/.vellum/workspace.
 *
 * Individual test files can retrieve the workspace dir via getWorkspaceDir()
 * from platform.ts, or directly from process.env.VELLUM_WORKSPACE_DIR.
 *
 * Cleanup: the temp dir is removed after all tests in the file complete.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

import { resetDb } from "../memory/db-connection.js";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "vellum-test-workspace-")),
);
process.env.VELLUM_WORKSPACE_DIR = testDir;
process.env.VELLUM_PLATFORM_URL = "https://test-platform.vellum.ai";

afterAll(() => {
  resetDb();
  delete process.env.VELLUM_WORKSPACE_DIR;
  delete process.env.VELLUM_PLATFORM_URL;
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
