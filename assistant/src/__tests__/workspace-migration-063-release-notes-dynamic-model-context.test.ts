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

import { releaseNotesDynamicModelContextMigration } from "../workspace/migrations/063-release-notes-dynamic-model-context.js";

const MIGRATION_ID = "063-release-notes-dynamic-model-context";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-063-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("workspace migration 063-release-notes-dynamic-model-context", () => {
  test("has the correct id", () => {
    expect(releaseNotesDynamicModelContextMigration.id).toBe(MIGRATION_ID);
  });

  test("creates UPDATES.md with marker and key copy when file is absent", () => {
    expect(existsSync(updatesPath())).toBe(false);

    releaseNotesDynamicModelContextMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content).toContain(MARKER);
    expect(content).toContain("max output tokens as a model-aware slider");
    expect(content).toContain("configure the context window per profile");
    expect(content).toContain("existing profiles");
  });

  test("is a no-op when marker is already present", () => {
    const seeded = `## Prior\n\n${MARKER}\nSomething.\n`;
    writeFileSync(updatesPath(), seeded, "utf-8");

    releaseNotesDynamicModelContextMigration.run(workspaceDir);

    expect(readFileSync(updatesPath(), "utf-8")).toBe(seeded);
  });

  test("appends to existing UPDATES.md when marker is absent", () => {
    const prior = "## Prior\n\nExisting release note.\n";
    writeFileSync(updatesPath(), prior, "utf-8");

    releaseNotesDynamicModelContextMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(prior)).toBe(true);
    expect(content).toContain(MARKER);
  });
});
