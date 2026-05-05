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
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

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

function markerCount(content: string): number {
  return content.split(MARKER).length - 1;
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

  test("creates UPDATES.md with marker and key copy when file is absent", () => {
    expect(existsSync(updatesPath())).toBe(false);

    releaseNotesSafeStorageLimitsMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content).toContain(MARKER);
    expect(content).toContain("safe-storage-limits");
    expect(content).toContain("critical 95% threshold");
    expect(content).toContain("trusted-contact messages");
  });

  test("is idempotent when run twice", () => {
    releaseNotesSafeStorageLimitsMigration.run(workspaceDir);
    releaseNotesSafeStorageLimitsMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(markerCount(content)).toBe(1);
    expect(content.match(/Safe storage limits/g)?.length).toBe(1);
  });

  test("appends to existing UPDATES.md when marker is absent", () => {
    const prior = "## Prior\n\nExisting release note.\n";
    writeFileSync(updatesPath(), prior, "utf-8");

    releaseNotesSafeStorageLimitsMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(prior)).toBe(true);
    expect(content).toContain(MARKER);
  });

  test("is a no-op when marker is already present", () => {
    const seeded = `## Prior\n\n${MARKER}\nAlready announced.\n`;
    writeFileSync(updatesPath(), seeded, "utf-8");

    releaseNotesSafeStorageLimitsMigration.run(workspaceDir);

    expect(readFileSync(updatesPath(), "utf-8")).toBe(seeded);
  });
});
