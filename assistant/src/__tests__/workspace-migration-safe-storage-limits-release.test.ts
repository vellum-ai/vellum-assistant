import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { releaseNotesSafeStorageLimitsMigration } from "../workspace/migrations/067-release-notes-safe-storage-limits.js";

const MIGRATION_ID = "067-release-notes-safe-storage-limits";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-067-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function updatesPath(): string {
  return join(workspaceDir, "UPDATES.md");
}

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("workspace migration 067-release-notes-safe-storage-limits", () => {
  test("has the correct id", () => {
    expect(releaseNotesSafeStorageLimitsMigration.id).toBe(MIGRATION_ID);
  });

  test("does not create UPDATES.md when file is absent", () => {
    expect(existsSync(updatesPath())).toBe(false);

    releaseNotesSafeStorageLimitsMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(false);
  });

  test("leaves existing UPDATES.md byte-identical", () => {
    const existing = "## Prior\n\nExisting release note.\n";
    writeFileSync(updatesPath(), existing, "utf-8");

    releaseNotesSafeStorageLimitsMigration.run(workspaceDir);

    expect(readFileSync(updatesPath(), "utf-8")).toBe(existing);
  });

  test("is idempotent when run twice in an empty workspace", () => {
    releaseNotesSafeStorageLimitsMigration.run(workspaceDir);
    releaseNotesSafeStorageLimitsMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(false);
  });

  test("is idempotent when run twice with existing UPDATES.md", () => {
    const existing = "## Prior\n\nExisting release note.\n";
    writeFileSync(updatesPath(), existing, "utf-8");

    releaseNotesSafeStorageLimitsMigration.run(workspaceDir);
    releaseNotesSafeStorageLimitsMigration.run(workspaceDir);

    expect(readFileSync(updatesPath(), "utf-8")).toBe(existing);
  });
});
