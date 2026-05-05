import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { getDb, resetDb } from "../memory/db-connection.js";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
const originalAllowRealWorkspace =
  process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS;
const originalTestRealWorkspace = process.env.VELLUM_TEST_REAL_WORKSPACE_DIR;
const originalHome = process.env.HOME;

afterEach(() => {
  resetDb();
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }

  if (originalAllowRealWorkspace === undefined) {
    delete process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS;
  } else {
    process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS =
      originalAllowRealWorkspace;
  }

  if (originalTestRealWorkspace === undefined) {
    delete process.env.VELLUM_TEST_REAL_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_TEST_REAL_WORKSPACE_DIR = originalTestRealWorkspace;
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

test("getDb refuses test runs without an isolated workspace", () => {
  resetDb();
  delete process.env.VELLUM_WORKSPACE_DIR;
  delete process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS;

  expect(() => getDb()).toThrow(
    "Refusing to open the assistant DB during tests without VELLUM_WORKSPACE_DIR",
  );
});

test("getDb refuses the real workspace during tests even when explicitly set", () => {
  resetDb();
  process.env.VELLUM_WORKSPACE_DIR = join(homedir(), ".vellum", "workspace");
  delete process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS;

  expect(() => getDb()).toThrow(
    "Refusing to open the real assistant workspace DB during tests",
  );
});

test("getDb refuses symlink aliases to the real workspace during tests", () => {
  resetDb();
  const testRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "vellum-db-isolation-")),
  );

  try {
    const fakeHome = join(testRoot, "home");
    const realWorkspace = join(fakeHome, ".vellum", "workspace");
    const aliasParent = join(testRoot, "aliases");
    const workspaceAlias = join(aliasParent, "workspace-link");

    mkdirSync(realWorkspace, { recursive: true });
    mkdirSync(aliasParent, { recursive: true });
    symlinkSync(realWorkspace, workspaceAlias, "dir");

    process.env.HOME = fakeHome;
    process.env.VELLUM_WORKSPACE_DIR = workspaceAlias;
    process.env.VELLUM_TEST_REAL_WORKSPACE_DIR = realWorkspace;
    delete process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS;

    expect(() => getDb()).toThrow(
      "Refusing to open the real assistant workspace DB during tests",
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("getDb refuses missing children under symlink aliases to the real workspace", () => {
  resetDb();
  const testRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "vellum-db-isolation-")),
  );

  try {
    const fakeHome = join(testRoot, "home");
    const realWorkspace = join(fakeHome, ".vellum", "workspace");
    const aliasParent = join(testRoot, "aliases");
    const workspaceLink = join(aliasParent, "workspace-link");
    const missingChild = join(workspaceLink, "new-test-workspace");

    mkdirSync(realWorkspace, { recursive: true });
    mkdirSync(aliasParent, { recursive: true });
    symlinkSync(realWorkspace, workspaceLink, "dir");

    process.env.HOME = fakeHome;
    process.env.VELLUM_WORKSPACE_DIR = missingChild;
    process.env.VELLUM_TEST_REAL_WORKSPACE_DIR = realWorkspace;
    delete process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS;

    expect(() => getDb()).toThrow(
      "Refusing to open the real assistant workspace DB during tests",
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
