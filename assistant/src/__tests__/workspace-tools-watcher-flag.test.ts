/**
 * Tests that the `workspace-tools-watcher` feature flag gates the dynamic
 * hot-reload watcher in `WorkspaceToolsWatcher.start()`.
 *
 * The initial disk scan (`loadWorkspaceTools()`) is unconditional and lives
 * elsewhere; this suite only covers whether the live `fs.watch` loop mounts.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearFeatureFlagOverridesCache } from "../config/assistant-feature-flags.js";
import { WorkspaceToolsWatcher } from "../daemon/workspace-tools-watcher.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

const FLAG = "workspace-tools-watcher";
const TEST_BASE_DIR = join(
  tmpdir(),
  `vellum-workspace-tools-watcher-flag-test-${process.pid}-${Date.now()}`,
);
let caseCounter = 0;

function freshWorkspaceWithToolsDir(): void {
  caseCounter += 1;
  const dir = join(TEST_BASE_DIR, `case-${caseCounter}`);
  mkdirSync(join(dir, "tools"), { recursive: true });
  process.env.VELLUM_WORKSPACE_DIR = dir;
}

beforeEach(() => {
  WorkspaceToolsWatcher.resetForTests();
  clearFeatureFlagOverridesCache();
  freshWorkspaceWithToolsDir();
});

afterEach(() => {
  WorkspaceToolsWatcher.resetForTests();
  clearFeatureFlagOverridesCache();
  delete process.env.VELLUM_WORKSPACE_DIR;
  rmSync(TEST_BASE_DIR, { recursive: true, force: true });
});

describe("WorkspaceToolsWatcher feature-flag gate", () => {
  test("does not mount the watch loop when the flag is off", () => {
    // GIVEN the workspace tools directory exists
    // AND the watcher flag is disabled
    setOverridesForTesting({ [FLAG]: false });

    // WHEN the watcher starts
    const watcher = WorkspaceToolsWatcher.getInstance();
    watcher.start();

    // THEN no fs.watch loop is mounted
    expect(watcher.isWatchingForTests()).toBe(false);
  });

  test("mounts the watch loop when the flag is on", () => {
    // GIVEN the workspace tools directory exists
    // AND the watcher flag is enabled
    setOverridesForTesting({ [FLAG]: true });

    // WHEN the watcher starts
    const watcher = WorkspaceToolsWatcher.getInstance();
    watcher.start();

    // THEN a live fs.watch loop is mounted
    expect(watcher.isWatchingForTests()).toBe(true);
  });
});
