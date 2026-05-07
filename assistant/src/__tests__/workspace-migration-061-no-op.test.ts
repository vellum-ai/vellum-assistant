import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { moveBackupKeyToWorkspaceMigration } from "../workspace/migrations/061-move-backup-key-to-workspace.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-061-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("061-move-backup-key-to-workspace migration (neutralized)", () => {
  test("has correct migration id and is registered", () => {
    expect(moveBackupKeyToWorkspaceMigration.id).toBe(
      "061-move-backup-key-to-workspace",
    );
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toContain(
      "061-move-backup-key-to-workspace",
    );
  });

  test("does NOT create .backup.key in the workspace (ATL-444)", () => {
    moveBackupKeyToWorkspaceMigration.run(workspaceDir);

    expect(existsSync(join(workspaceDir, ".backup.key"))).toBe(false);
  });

  test("is a no-op — leaves the workspace untouched", () => {
    moveBackupKeyToWorkspaceMigration.run(workspaceDir);

    // Empty workspace dir should remain empty.
    expect(readdirSync(workspaceDir)).toEqual([]);
  });

  test("down() is a no-op", () => {
    expect(() => moveBackupKeyToWorkspaceMigration.down(workspaceDir)).not.toThrow();
    expect(existsSync(join(workspaceDir, ".backup.key"))).toBe(false);
  });
});
