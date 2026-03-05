import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Isolated temp directory per run
// ---------------------------------------------------------------------------

const TEST_DIR = join(
  tmpdir(),
  `vellum-config-migration-test-${randomBytes(4).toString("hex")}`,
);
const WORKSPACE_DIR = join(TEST_DIR, "workspace");
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

// ---------------------------------------------------------------------------
// Mocks — declared before imports so module-level code sees them
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../util/platform.js", () => ({
  getRootDir: () => TEST_DIR,
  getWorkspaceDir: () => WORKSPACE_DIR,
  getWorkspaceConfigPath: () => CONFIG_PATH,
  getDataDir: () => join(TEST_DIR, "data"),
  getLogPath: () => join(TEST_DIR, "logs", "vellum.log"),
  ensureDataDir: () => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    if (!existsSync(WORKSPACE_DIR))
      mkdirSync(WORKSPACE_DIR, { recursive: true });
  },
  migrateToWorkspaceLayout: () => {},
  migrateToDataLayout: () => {},
  migratePath: () => {},
  isMacOS: () => false,
  isLinux: () => false,
  isWindows: () => false,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: () => null,
  setSecureKey: () => true,
  deleteSecureKey: () => {},
}));

import { invalidateConfigCache, loadConfig } from "../config/loader.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("config loader migration", () => {
  beforeEach(() => {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    invalidateConfigCache();
  });

  afterEach(() => {
    invalidateConfigCache();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('raw permissions.mode "legacy" is migrated to "workspace" during load', () => {
    // Simulate a config file left over from a previous release that still
    // has permissions.mode set to "legacy". The loader's migrateRawConfig
    // step must rewrite this to "workspace" before Zod validation, because
    // the schema no longer accepts "legacy" as a valid enum value.
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ permissions: { mode: "legacy" } }, null, 2) + "\n",
    );

    const config = loadConfig();

    expect(config.permissions.mode).toBe("workspace");
  });
});
