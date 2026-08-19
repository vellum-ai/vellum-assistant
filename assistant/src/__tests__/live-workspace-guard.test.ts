/**
 * Tests for the live-workspace guard in util/platform.ts: a test process must
 * never resolve the workspace to a directory outside os.tmpdir().
 *
 * The guard memoizes successful validations per directory string, so each
 * assertion uses a distinct path rather than reusing one across tests.
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { getWorkspaceDir } from "../util/platform.js";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;

afterEach(() => {
  process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  delete process.env.VELLUM_TEST_ALLOW_REAL_WORKSPACE;
});

describe("live-workspace guard", () => {
  test("allows the preload's tmpdir workspace", () => {
    expect(getWorkspaceDir()).toBe(process.env.VELLUM_WORKSPACE_DIR!);
  });

  test("allows a not-yet-created dir whose parent is tmpdir", () => {
    const dir = join(tmpdir(), "vellum-guard-nonexistent-workspace");
    process.env.VELLUM_WORKSPACE_DIR = dir;
    expect(getWorkspaceDir()).toBe(dir);
  });

  test("refuses a non-tmpdir workspace in a test process", () => {
    process.env.VELLUM_WORKSPACE_DIR = join(homedir(), "vellum-guard-live");
    expect(() => getWorkspaceDir()).toThrow(/Refusing to use workspace/);
  });

  test("VELLUM_TEST_ALLOW_REAL_WORKSPACE=1 bypasses the guard", () => {
    const dir = join(homedir(), "vellum-guard-live-optout");
    process.env.VELLUM_WORKSPACE_DIR = dir;
    process.env.VELLUM_TEST_ALLOW_REAL_WORKSPACE = "1";
    expect(getWorkspaceDir()).toBe(dir);
  });

  test("opt-out is per-call, not cached: same dir throws once the var clears", () => {
    const dir = join(homedir(), "vellum-guard-live-optout-cleared");
    process.env.VELLUM_WORKSPACE_DIR = dir;
    process.env.VELLUM_TEST_ALLOW_REAL_WORKSPACE = "1";
    expect(getWorkspaceDir()).toBe(dir);
    delete process.env.VELLUM_TEST_ALLOW_REAL_WORKSPACE;
    expect(() => getWorkspaceDir()).toThrow(/Refusing to use workspace/);
  });
});
