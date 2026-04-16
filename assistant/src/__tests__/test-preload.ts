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

import { installGatewayIpcMock } from "../__tests__/mock-gateway-ipc.js";
import { resetDb } from "../memory/db-connection.js";
import { _setStorePath } from "../security/encrypted-store.js";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "vellum-test-workspace-")),
);
process.env.VELLUM_WORKSPACE_DIR = testDir;
process.env.VELLUM_PLATFORM_URL = "https://test-platform.vellum.ai";
process.exitCode = 0;

// Isolate the encrypted credential store per test file. Without this,
// parallel test processes all read/write the same ~/.vellum/protected/keys.enc,
// causing races when one file deletes a key while another sets it.
_setStorePath(join(testDir, "keys.enc"));

// Mock gateway IPC so no test accidentally connects to a real gateway socket.
// Tests that need to control IPC responses use mockGatewayIpc() / resetMockGatewayIpc().
installGatewayIpcMock();

// Force-close any DB connection inherited from the parent process (e.g. when
// the test runner is spawned by the running assistant via a pre-push hook).
// Without this, the db singleton in db-connection.ts may still point at the
// real ~/.vellum/workspace database, and test cleanup (DELETE FROM …) would
// wipe production data — contacts, channels, credentials, etc.
resetDb();

// Prevent tests from routing credential writes through the real CES
// (Credential Execution Service). Without this, setSecureKeyAsync() in
// containerized environments writes to the live credential store.
const savedIsContainerized = process.env.IS_CONTAINERIZED;
const savedCesCredentialUrl = process.env.CES_CREDENTIAL_URL;
delete process.env.IS_CONTAINERIZED;
delete process.env.CES_CREDENTIAL_URL;

afterAll(() => {
  resetDb();
  process.exitCode = 0;
  delete process.env.VELLUM_WORKSPACE_DIR;
  delete process.env.VELLUM_PLATFORM_URL;
  if (savedIsContainerized !== undefined) {
    process.env.IS_CONTAINERIZED = savedIsContainerized;
  }
  if (savedCesCredentialUrl !== undefined) {
    process.env.CES_CREDENTIAL_URL = savedCesCredentialUrl;
  }
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
