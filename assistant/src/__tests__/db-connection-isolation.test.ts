import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { getDb, resetDb } from "../memory/db-connection.js";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
const originalAllowRealWorkspace =
  process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS;

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
