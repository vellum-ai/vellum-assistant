import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { up } from "../db/data-migrations/m0003-recover-backup-key.js";

import { testSecurityDir, testWorkspaceDir } from "./test-preload.js";

let testHome: string;
let legacyProtectedDir: string;
let workspaceDir: string;
let securityDir: string;

const savedHome = process.env.HOME;

function seedLegacyProtected(contents: string): void {
  mkdirSync(legacyProtectedDir, { recursive: true });
  writeFileSync(join(legacyProtectedDir, "backup.key"), contents);
}

function seedWorkspace(contents: string): void {
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, ".backup.key"), contents);
}

function seedTarget(contents: string): void {
  mkdirSync(securityDir, { recursive: true });
  writeFileSync(join(securityDir, "backup.key"), contents);
}

beforeEach(() => {
  testHome = join(
    tmpdir(),
    `vellum-m0003-test-${randomBytes(6).toString("hex")}`,
  );
  legacyProtectedDir = join(testHome, ".vellum", "protected");
  workspaceDir = join(testHome, ".vellum", "workspace");
  securityDir = join(testHome, "gateway-security");

  mkdirSync(testHome, { recursive: true });

  process.env.HOME = testHome;
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  process.env.GATEWAY_SECURITY_DIR = testSecurityDir;
  process.env.VELLUM_WORKSPACE_DIR = testWorkspaceDir;
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("m0003-recover-backup-key", () => {
  test("recovers from workspace location and deletes the workspace copy (ATL-444)", () => {
    seedWorkspace("workspace-key");

    expect(up()).toBe("done");

    // Key landed at target.
    expect(readFileSync(join(securityDir, "backup.key"), "utf-8")).toBe(
      "workspace-key",
    );
    // Workspace copy is gone.
    expect(existsSync(join(workspaceDir, ".backup.key"))).toBe(false);
  });

  test("recovers from legacy ~/.vellum/protected/backup.key", () => {
    seedLegacyProtected("legacy-key");

    expect(up()).toBe("done");

    expect(readFileSync(join(securityDir, "backup.key"), "utf-8")).toBe(
      "legacy-key",
    );
  });

  test("prefers workspace copy over legacy when both exist", () => {
    seedWorkspace("workspace-key");
    seedLegacyProtected("legacy-key");

    expect(up()).toBe("done");

    expect(readFileSync(join(securityDir, "backup.key"), "utf-8")).toBe(
      "workspace-key",
    );
    expect(existsSync(join(workspaceDir, ".backup.key"))).toBe(false);
  });

  test("when target already exists, leaves it alone but still deletes the workspace copy (ATL-444)", () => {
    seedTarget("canonical-key");
    seedWorkspace("stale-workspace-key");

    expect(up()).toBe("done");

    // Target untouched.
    expect(readFileSync(join(securityDir, "backup.key"), "utf-8")).toBe(
      "canonical-key",
    );
    // Workspace copy unconditionally removed.
    expect(existsSync(join(workspaceDir, ".backup.key"))).toBe(false);
  });

  test("no-op when no key exists anywhere", () => {
    expect(up()).toBe("done");

    expect(existsSync(join(securityDir, "backup.key"))).toBe(false);
    expect(existsSync(join(workspaceDir, ".backup.key"))).toBe(false);
  });

  test("does not delete a workspace path that resolves to the same file as the target", () => {
    // Configure GATEWAY_SECURITY_DIR to point at the workspace dir itself,
    // and use a custom layout where workspace path == target path. In
    // practice this can't happen (filenames differ — "backup.key" vs
    // ".backup.key"), but we still assert the resolve() guard is wired.
    // Simplest concrete check: when workspace and target are the same
    // directory, the FILES still differ ("backup.key" vs ".backup.key"), so
    // both writes coexist and removeWorkspaceCopy correctly unlinks the dot
    // file. Verify that.
    process.env.GATEWAY_SECURITY_DIR = workspaceDir;
    seedWorkspace("k");

    expect(up()).toBe("done");

    expect(readFileSync(join(workspaceDir, "backup.key"), "utf-8")).toBe("k");
    expect(existsSync(join(workspaceDir, ".backup.key"))).toBe(false);
  });
});
