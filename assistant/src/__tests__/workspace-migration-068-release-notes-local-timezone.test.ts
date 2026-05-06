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

import { releaseNotesLocalTimezoneMigration } from "../workspace/migrations/068-release-notes-local-timezone.js";

const MIGRATION_ID = "068-release-notes-local-timezone";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

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

describe("workspace migration 068-release-notes-local-timezone", () => {
  test("has the correct id", () => {
    expect(releaseNotesLocalTimezoneMigration.id).toBe(MIGRATION_ID);
  });

  test("creates UPDATES.md with marker and key copy when file is absent", () => {
    expect(existsSync(updatesPath())).toBe(false);

    releaseNotesLocalTimezoneMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content).toContain(MARKER);
    expect(content).toContain("Local timezone grounding");
    expect(content).toContain("device timezone");
    expect(content).toContain("Manual timezone overrides still win");
  });

  test("is idempotent when run twice", () => {
    releaseNotesLocalTimezoneMigration.run(workspaceDir);
    releaseNotesLocalTimezoneMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(markerCount(content)).toBe(1);
    expect(content.match(/Local timezone grounding/g)?.length).toBe(1);
  });

  test("appends to existing UPDATES.md when marker is absent", () => {
    const prior = "## Prior\n\nExisting release note.\n";
    writeFileSync(updatesPath(), prior, "utf-8");

    releaseNotesLocalTimezoneMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(prior)).toBe(true);
    expect(content).toContain(MARKER);
  });

  test("is a no-op when marker is already present", () => {
    const seeded = `## Prior\n\n${MARKER}\nAlready announced.\n`;
    writeFileSync(updatesPath(), seeded, "utf-8");

    releaseNotesLocalTimezoneMigration.run(workspaceDir);

    expect(readFileSync(updatesPath(), "utf-8")).toBe(seeded);
  });
});
