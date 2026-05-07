import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cleanupWorkspaceBackupKeyMigration } from "../workspace/migrations/072-cleanup-workspace-backup-key.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

let vellumRoot: string;
let workspaceDir: string;
let protectedDir: string;
let workspaceKeyPath: string;
let protectedKeyPath: string;

const savedWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;

function freshLayout(): void {
  vellumRoot = join(
    tmpdir(),
    `vellum-migration-072-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  workspaceDir = join(vellumRoot, "workspace");
  protectedDir = join(vellumRoot, "protected");
  workspaceKeyPath = join(workspaceDir, ".backup.key");
  protectedKeyPath = join(protectedDir, "backup.key");
  mkdirSync(workspaceDir, { recursive: true });
  // protectedDir is created by the migration when needed
}

beforeEach(() => {
  freshLayout();
  // getVellumRoot() returns dirname(VELLUM_WORKSPACE_DIR) when set.
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  if (savedWorkspaceEnv === undefined) delete process.env.VELLUM_WORKSPACE_DIR;
  else process.env.VELLUM_WORKSPACE_DIR = savedWorkspaceEnv;
  if (existsSync(vellumRoot)) {
    rmSync(vellumRoot, { recursive: true, force: true });
  }
});

describe("072-cleanup-workspace-backup-key migration", () => {
  test("has correct migration id and is registered", () => {
    expect(cleanupWorkspaceBackupKeyMigration.id).toBe(
      "072-cleanup-workspace-backup-key",
    );
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toContain(
      "072-cleanup-workspace-backup-key",
    );
  });

  test("relocates a leftover workspace .backup.key to ~/.vellum/protected/backup.key", () => {
    writeFileSync(workspaceKeyPath, "secret-bytes");

    cleanupWorkspaceBackupKeyMigration.run(workspaceDir);

    expect(existsSync(workspaceKeyPath)).toBe(false);
    expect(existsSync(protectedKeyPath)).toBe(true);
    expect(readFileSync(protectedKeyPath, "utf-8")).toBe("secret-bytes");
  });

  test("when protected key already exists, deletes the workspace duplicate without overwriting", () => {
    writeFileSync(workspaceKeyPath, "workspace-bytes");
    mkdirSync(protectedDir, { recursive: true });
    writeFileSync(protectedKeyPath, "canonical-bytes");

    cleanupWorkspaceBackupKeyMigration.run(workspaceDir);

    expect(existsSync(workspaceKeyPath)).toBe(false);
    expect(readFileSync(protectedKeyPath, "utf-8")).toBe("canonical-bytes");
  });

  test("is a no-op when no workspace key is present", () => {
    cleanupWorkspaceBackupKeyMigration.run(workspaceDir);

    expect(existsSync(workspaceKeyPath)).toBe(false);
    expect(existsSync(protectedKeyPath)).toBe(false);
  });

  test("idempotent — second run does nothing additional", () => {
    writeFileSync(workspaceKeyPath, "secret");

    cleanupWorkspaceBackupKeyMigration.run(workspaceDir);
    cleanupWorkspaceBackupKeyMigration.run(workspaceDir);

    expect(existsSync(workspaceKeyPath)).toBe(false);
    expect(readFileSync(protectedKeyPath, "utf-8")).toBe("secret");
  });

  test("down() never restores a workspace .backup.key (forward-only)", () => {
    cleanupWorkspaceBackupKeyMigration.down(workspaceDir);

    expect(existsSync(workspaceKeyPath)).toBe(false);
  });

  test("does not delete the workspace key if the protected dir cannot be created", () => {
    writeFileSync(workspaceKeyPath, "secret");
    // Make vellumRoot read-only so mkdir(protectedDir) fails.
    // (Skip this test surface on root; chmod 0500 still allows root to write.)
    if (process.getuid?.() === 0) {
      // Root bypasses permission checks; skip the safety assertion here and
      // trust the explicit try/catch in the migration.
      return;
    }

    chmodSync(vellumRoot, 0o500);
    try {
      cleanupWorkspaceBackupKeyMigration.run(workspaceDir);

      // Workspace key must remain — losing the only copy would be unsafe.
      expect(existsSync(workspaceKeyPath)).toBe(true);
      expect(existsSync(protectedKeyPath)).toBe(false);
    } finally {
      chmodSync(vellumRoot, 0o700);
    }
  });
});
