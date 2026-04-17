/**
 * Shared test preload — runs before every gateway test file.
 *
 * Creates a per-file temporary directory tree and sets GATEWAY_SECURITY_DIR
 * and VELLUM_WORKSPACE_DIR so that gateway code resolves under the temp dir
 * instead of the real ~/.vellum paths.
 *
 * Exports:
 *   testSecurityDir  — the per-file temp GATEWAY_SECURITY_DIR
 *   testWorkspaceDir — the per-file temp VELLUM_WORKSPACE_DIR
 *
 * These are safe to import from any test file:
 *
 *   import { testSecurityDir, testWorkspaceDir } from "./test-preload.js";
 *
 * Cleanup: the temp dir tree is removed after all tests in the file complete.
 * The original env vars are restored so that back-to-back test files in the
 * same process (if Bun ever batches them) don't leak state.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

// ---------------------------------------------------------------------------
// Create isolated directory tree
// ---------------------------------------------------------------------------

const testRoot = realpathSync(
  mkdtempSync(join(tmpdir(), "vellum-gateway-test-")),
);

export const testSecurityDir = join(testRoot, "protected");
export const testWorkspaceDir = join(testRoot, "workspace");

mkdirSync(testSecurityDir, { recursive: true });
mkdirSync(testWorkspaceDir, { recursive: true });

// ---------------------------------------------------------------------------
// Save originals and set env vars
// ---------------------------------------------------------------------------

const savedSecurityDir = process.env.GATEWAY_SECURITY_DIR;
const savedWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
const savedCesCredentialUrl = process.env.CES_CREDENTIAL_URL;
const savedCesServiceToken = process.env.CES_SERVICE_TOKEN;

process.env.GATEWAY_SECURITY_DIR = testSecurityDir;
process.env.VELLUM_WORKSPACE_DIR = testWorkspaceDir;

// Prevent tests from hitting a real CES sidecar that may be running
// in the sandbox. Without this, readCredential() resolves secrets from
// the live credential store instead of test fixtures.
delete process.env.CES_CREDENTIAL_URL;
delete process.env.CES_SERVICE_TOKEN;

// ---------------------------------------------------------------------------
// Restore and cleanup
// ---------------------------------------------------------------------------

afterAll(() => {
  if (savedSecurityDir === undefined) {
    delete process.env.GATEWAY_SECURITY_DIR;
  } else {
    process.env.GATEWAY_SECURITY_DIR = savedSecurityDir;
  }

  if (savedWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = savedWorkspaceDir;
  }

  if (savedCesCredentialUrl === undefined) {
    delete process.env.CES_CREDENTIAL_URL;
  } else {
    process.env.CES_CREDENTIAL_URL = savedCesCredentialUrl;
  }

  if (savedCesServiceToken === undefined) {
    delete process.env.CES_SERVICE_TOKEN;
  } else {
    process.env.CES_SERVICE_TOKEN = savedCesServiceToken;
  }

  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
