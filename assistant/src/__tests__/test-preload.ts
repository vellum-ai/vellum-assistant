/**
 * Shared test preload — runs before every test file.
 *
 * Creates a per-process temporary directory and sets VELLUM_WORKSPACE_DIR so
 * that all workspace-derived helpers (getDataDir, getDbPath,
 * getConversationsDir, getProtectedDir, …) resolve under the temp dir
 * instead of the real ~/.vellum/workspace.
 *
 * Cleanup: the temp dir is removed after all tests in the file complete.
 *
 * Zero source-module imports
 * --------------------------
 * The only static imports in this file are node stdlib (`node:fs`,
 * `node:os`, `node:path`), `bun:test`, and `./mock-gateway-ipc.js` — which
 * itself imports only node stdlib + `bun:test`. No source-module import
 * runs at preload-load time, so a broken `node_modules` symlink (the
 * DB ghost #3 failure shape — see
 * /workspace/journal/2026-05-25-db-ghost-3-recovery.md) cannot prevent
 * the env override below from running.
 *
 * Three prior preload-side setup calls were replaced with node-module-free
 * alternatives:
 *
 * 1. `_setOverridesForTesting({})` — the gateway IPC mock now returns a
 *    sentinel for `get_feature_flags` so `initFeatureFlagOverrides()`
 *    doesn't hit the 7.75 s empty-result retry loop. Tests that need
 *    specific flag state still call `mockGatewayIpc()` or
 *    `_setOverridesForTesting()` directly from their own setup.
 *
 * 2. `resetDb()` — was a no-op at preload time: bun test processes start
 *    with a fresh JS heap, so the `db-connection.ts` singleton is `null`.
 *    The first test to call `getDb()` lazily opens a connection pointing
 *    at the already-set `VELLUM_WORKSPACE_DIR`.
 *
 * 3. `_setStorePath(join(testDir, "keys.enc"))` — the testDir layout is
 *    now `<tmpRoot>/workspace`, so `vellumRoot()` (which derives from
 *    `dirname(VELLUM_WORKSPACE_DIR)`) resolves to `<tmpRoot>` per
 *    process. `getProtectedDir()` resolves to `<tmpRoot>/protected`,
 *    naturally isolated.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

import { installGatewayIpcMock } from "./mock-gateway-ipc.js";

// --- Phase 1: env override (zero source-module imports above this point) ---

// Layout: <tmpRoot>/workspace as VELLUM_WORKSPACE_DIR. The parent of
// VELLUM_WORKSPACE_DIR is what `vellumRoot()` resolves to, so a separate
// tmpRoot per process gives `getProtectedDir()` and friends per-process
// isolation without needing `_setStorePath()`.
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "vellum-test-")));
const testDir = join(tmpRoot, "workspace");
mkdirSync(testDir);
process.env.VELLUM_WORKSPACE_DIR = testDir;
process.env.VELLUM_PLATFORM_URL = "https://test-platform.vellum.ai";
process.exitCode = 0;

// Prevent tests from routing credential writes through the real CES
// (Credential Execution Service). Without this, setSecureKeyAsync() in
// containerized environments writes to the live credential store.
const savedIsContainerized = process.env.IS_CONTAINERIZED;
const savedCesCredentialUrl = process.env.CES_CREDENTIAL_URL;
delete process.env.IS_CONTAINERIZED;
delete process.env.CES_CREDENTIAL_URL;

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
