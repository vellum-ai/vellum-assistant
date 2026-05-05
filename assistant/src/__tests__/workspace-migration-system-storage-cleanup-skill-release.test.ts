import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { releaseNotesSystemStorageCleanupSkillMigration } from "../workspace/migrations/068-release-notes-system-storage-cleanup-skill.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

const MIGRATION_ID = "068-release-notes-system-storage-cleanup-skill";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;
const RELEASE_NOTE_HEADING = "## Storage cleanup guide";
const RELEASE_NOTE_COPY =
  "Storage cleanup mode now uses a dedicated cleanup guide.";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-068-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function updatesPath(): string {
  return join(workspaceDir, "UPDATES.md");
}

function occurrenceCount(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("workspace migration 068-release-notes-system-storage-cleanup-skill", () => {
  test("has the correct id and is registered", () => {
    expect(releaseNotesSystemStorageCleanupSkillMigration.id).toBe(
      MIGRATION_ID,
    );
    expect(WORKSPACE_MIGRATIONS.map((migration) => migration.id)).toContain(
      MIGRATION_ID,
    );
  });

  test("is idempotent when run twice", () => {
    releaseNotesSystemStorageCleanupSkillMigration.run(workspaceDir);
    releaseNotesSystemStorageCleanupSkillMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(occurrenceCount(content, MARKER)).toBe(1);
    expect(occurrenceCount(content, RELEASE_NOTE_HEADING)).toBe(1);
    expect(occurrenceCount(content, RELEASE_NOTE_COPY)).toBe(1);
    expect(content).toContain("diagnose large files");
    expect(content).toMatch(/database\s+growth needs product maintenance/);
    expect(content).toContain("ask before deleting anything");
  });
});
