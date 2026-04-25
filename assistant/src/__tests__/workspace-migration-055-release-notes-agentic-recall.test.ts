import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { releaseNotesAgenticRecallMigration } from "../workspace/migrations/055-release-notes-agentic-recall.js";

const MIGRATION_ID = "055-release-notes-agentic-recall";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

let testRoot: string;
let workspaceDir: string;

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "migration-055-test-"));
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  workspaceDir = mkdtempSync(join(testRoot, "ws-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function updatesPath(): string {
  return join(workspaceDir, "UPDATES.md");
}

describe("workspace migration 055-release-notes-agentic-recall", () => {
  test("has the correct id and description", () => {
    expect(releaseNotesAgenticRecallMigration.id).toBe(MIGRATION_ID);
    expect(releaseNotesAgenticRecallMigration.description).toContain("recall");
  });

  test("creates UPDATES.md with marker and key copy when file is absent", () => {
    expect(existsSync(updatesPath())).toBe(false);

    releaseNotesAgenticRecallMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(MARKER)).toBe(true);
    expect(content).toContain("Recall can search more places now");
    expect(content).toContain("memory");
    expect(content).toContain("knowledge base notes");
    expect(content).toContain("past conversations");
    expect(content).toContain("workspace files");
  });

  test("appends to existing UPDATES.md when marker is absent and preserves existing content", () => {
    const prior = "## Earlier note\n\nSomething already queued.\n";
    writeFileSync(updatesPath(), prior, "utf-8");

    releaseNotesAgenticRecallMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(prior)).toBe(true);
    expect(content.slice(prior.length).startsWith(`\n${MARKER}`)).toBe(true);
    expect(content.split(MARKER).length - 1).toBe(1);
    expect(content).not.toContain("\n\n\n");
  });

  test("is a no-op when marker is already present", () => {
    const seeded = `## Prior\n\n${MARKER}\n## Recall\n\nAlready appended.\n`;
    writeFileSync(updatesPath(), seeded, "utf-8");

    releaseNotesAgenticRecallMigration.run(workspaceDir);
    const afterFirst = readFileSync(updatesPath(), "utf-8");
    expect(afterFirst).toBe(seeded);

    releaseNotesAgenticRecallMigration.run(workspaceDir);
    const afterSecond = readFileSync(updatesPath(), "utf-8");
    expect(afterSecond).toBe(seeded);
    expect(afterSecond.split(MARKER).length - 1).toBe(1);
  });

  test("re-creates UPDATES.md when it was deleted between runs", () => {
    releaseNotesAgenticRecallMigration.run(workspaceDir);
    expect(existsSync(updatesPath())).toBe(true);

    rmSync(updatesPath());

    releaseNotesAgenticRecallMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(MARKER)).toBe(true);
    expect(content).toContain("workspace files");
  });

  test("existing UPDATES.md with no trailing newline gets one blank line separator", () => {
    const prior = "## Prior\n\nBody.";
    writeFileSync(updatesPath(), prior, "utf-8");

    releaseNotesAgenticRecallMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(prior)).toBe(true);
    expect(content.slice(prior.length).startsWith(`\n\n${MARKER}`)).toBe(true);
    expect(content).not.toContain("\n\n\n");
  });

  test("down() is a no-op", () => {
    writeFileSync(updatesPath(), `${MARKER}\nBody.\n`, "utf-8");
    const before = readFileSync(updatesPath(), "utf-8");

    releaseNotesAgenticRecallMigration.down(workspaceDir);

    expect(readFileSync(updatesPath(), "utf-8")).toBe(before);
  });
});
