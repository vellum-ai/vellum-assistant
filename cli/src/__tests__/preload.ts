/**
 * Shared CLI test preload — runs before every test file.
 *
 * Sets VELLUM_WORKSPACE_DIR to a temporary directory so that any CLI helper
 * that resolves workspace paths won't accidentally touch the real workspace.
 *
 * Cleanup: the temp dir is removed after all tests in the file complete.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "vellum-cli-test-workspace-")),
);
process.env.VELLUM_WORKSPACE_DIR = testDir;

afterAll(() => {
  delete process.env.VELLUM_WORKSPACE_DIR;
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
