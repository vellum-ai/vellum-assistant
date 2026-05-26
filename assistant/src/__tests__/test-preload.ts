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
 * No source-module imports
 * ------------------------
 * The only static imports in this file are node stdlib (`node:fs`,
 * `node:os`, `node:path`), `bun:test`, and `./mock-gateway-ipc.js` — which
 * itself imports only node stdlib + `bun:test`. No source-module import
 * runs at preload-load time, so a broken `node_modules` symlink (the
 * DB ghost #3 failure shape — see
 * /workspace/journal/2026-05-25-db-ghost-3-recovery.md) cannot prevent
 * the env override below from running.
 *
 * No setup helpers in the production hot path
 * -------------------------------------------
 * Three formerly-source-side test helpers were lifted out of production
 * modules into `__tests__/` so the preload (and test files) can use
 * them without dragging the production modules' heavy dependencies
 * (pino, drizzle) through the preload's import chain:
 *
 *   - `setOverridesForTesting` — `__tests__/feature-flag-test-helpers.ts`
 *     (writes to `config/feature-flag-cache.ts`, stdlib-only).
 *     Not called here: the gateway IPC mock below returns a sentinel
 *     for `get_feature_flags` so `initFeatureFlagOverrides()` short-
 *     circuits the 7.75 s retry loop without preseed.
 *
 *   - `resetDbForTesting` — `__tests__/db-test-helpers.ts`
 *     (calls `clearStoredDb` from `memory/db-singleton.ts`, stdlib-only).
 *     Not called here: a fresh bun-test process starts with an empty JS
 *     heap, so the singleton is `null` until a test calls `getDb()`.
 *
 *   - `setStorePathForTesting` — `__tests__/encrypted-store-test-helpers.ts`
 *     (writes to `security/store-path-override.ts`, stdlib-only).
 *     Not called here: the testDir layout `<tmpRoot>/workspace` makes
 *     `getProtectedDir()` resolve per-process naturally.
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
// isolation without needing an explicit `setStorePathForTesting()`.
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
