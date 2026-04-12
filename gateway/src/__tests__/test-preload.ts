/**
 * Shared test preload — runs before every gateway test file.
 *
 * Creates a per-file temporary directory and sets GATEWAY_SECURITY_DIR so that
 * getGatewaySecurityDir() resolves under the temp dir instead of the real
 * ~/.vellum/protected.
 *
 * Cleanup: the temp dir is removed after all tests in the file complete.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "vellum-gateway-test-")),
);
process.env.GATEWAY_SECURITY_DIR = testDir;

afterAll(() => {
  delete process.env.GATEWAY_SECURITY_DIR;
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
