/**
 * Shared test preload — runs before every test file.
 *
 * Creates a per-process temporary directory and sets VELLUM_WORKSPACE_DIR so
 * that all workspace-derived helpers (getDataDir, getDbPath,
 * getConversationsDir, getProtectedDir, …) resolve under the temp dir
 * instead of the real $VELLUM_WORKSPACE_DIR.
 *
 * Cleanup: the temp dir is removed after all tests in the file complete.
 *
 * No source-module imports
 * ------------------------
 * The only static imports in this file are node stdlib (`node:fs`,
 * `node:os`, `node:path`), `bun:test`, and helpers in this same directory.
 * Importing from the assistant directly runs the risk of triggering import
 * time side effects and import from node modules that may not exist in
 * some environments.
 */

import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

import { installGatewayIpcMock } from "./mock-gateway-ipc.js";

// --- Phase 1: env override (zero source-module imports above this point) ---

// Layout: <tmpRoot>/workspace as VELLUM_WORKSPACE_DIR. The parent of
// VELLUM_WORKSPACE_DIR is what `vellumRoot()` resolves to, so a separate
// tmpRoot per process gives `getProtectedDir()` and friends per-process
// isolation without needing an explicit `setStorePathForTesting()`.
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "vellum-test-")));
const testDir = join(tmpRoot, "workspace");
mkdirSync(testDir);
process.env.VELLUM_WORKSPACE_DIR = testDir;
process.env.VELLUM_PLATFORM_URL = "https://test-platform.vellum.ai";
process.exitCode = 0;

// Seed this workspace from the prebuilt "migrated" fixture (a pre-migrated set
// of the four assistant DBs) so a test's initializeDb() finds an already-migrated
// DB and the migration runner no-ops instead of re-running the whole chain; when
// VELLUM_TEST_FIXTURES_DIR is unset (a lone `bun test`) nothing is copied and the
// full chain runs. Plain recursive file copy — no `src/` import.
const fixturesDir = process.env.VELLUM_TEST_FIXTURES_DIR;
if (fixturesDir) {
  cpSync(join(fixturesDir, "migrated"), testDir, { recursive: true });
}

// Prevent tests from routing credential writes through the real CES
// (Credential Execution Service). Without this, setSecureKeyAsync() in
// containerized environments writes to the live credential store.
const savedIsContainerized = process.env.IS_CONTAINERIZED;
const savedCesCredentialUrl = process.env.CES_CREDENTIAL_URL;
delete process.env.IS_CONTAINERIZED;
delete process.env.CES_CREDENTIAL_URL;

// A test runs daemon code in-process, so it acts as the main daemon for the
// event hub's publish routing (a non-daemon forwards publishes over IPC to a
// daemon that isn't there). Default the shared process-role slot to true; a
// test simulating a worker overrides it. Written directly (not via
// `runtime/process-role.ts`) to keep the preload free of source-module imports;
// the slot is typed by the ambient `VellumAssistantNamespace` global (declared
// in `src/vellum-assistant-namespace.d.ts`), so no import is needed to touch it.
(globalThis.vellumAssistant ??= {}).mainDaemonProcess = true;

// --- Phase 2: install the IPC mock (no source-module imports) ---

// Mock gateway IPC so no test accidentally connects to a real gateway socket.
// The mock returns a sentinel for `get_feature_flags` to short-circuit the
// retry loop in `initFeatureFlagOverrides()`. Tests that need specific IPC
// responses use `mockGatewayIpc()` / `resetMockGatewayIpc()`.
installGatewayIpcMock();

afterAll(() => {
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
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
