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

import { releaseNotesDefaultSonnetMigration } from "../workspace/migrations/047-release-notes-default-sonnet.js";

const MIGRATION_ID = "047-release-notes-default-sonnet";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

let testRoot: string;
let workspaceDir: string;

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "migration-047-test-"));
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

describe("workspace migration 047-release-notes-default-sonnet", () => {
  test("has the correct id", () => {
    expect(releaseNotesDefaultSonnetMigration.id).toBe(MIGRATION_ID);
  });

  test("creates UPDATES.md with marker and key copy when file is absent", () => {
    expect(existsSync(updatesPath())).toBe(false);

    releaseNotesDefaultSonnetMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content).toContain(MARKER);
    expect(content).toContain("Claude Sonnet 4.6");
    expect(content).toContain("main agent");
    expect(content).toContain("claude-opus-4-7");
    expect(content.startsWith(MARKER)).toBe(true);
  });

  test("is a no-op when marker is already present", () => {
    const seeded = `## Prior\n\n${MARKER}\nSomething.\n`;
    writeFileSync(updatesPath(), seeded, "utf-8");

    releaseNotesDefaultSonnetMigration.run(workspaceDir);
    const first = readFileSync(updatesPath(), "utf-8");
    expect(first).toBe(seeded);

    releaseNotesDefaultSonnetMigration.run(workspaceDir);
    const second = readFileSync(updatesPath(), "utf-8");
    expect(second).toBe(seeded);
    expect(second.split(MARKER).length - 1).toBe(1);
  });

  test("appends to existing UPDATES.md when marker is absent", () => {
    const prior = "## Earlier note\n\nBody.\n";
    writeFileSync(updatesPath(), prior, "utf-8");

    releaseNotesDefaultSonnetMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(prior)).toBe(true);
    expect(content).toContain(MARKER);
    expect(content).not.toContain("\n\n\n");
  });

  test("down() is a no-op", () => {
    writeFileSync(updatesPath(), `${MARKER}\nBody.\n`, "utf-8");
    const before = readFileSync(updatesPath(), "utf-8");

    releaseNotesDefaultSonnetMigration.down(workspaceDir);

    expect(readFileSync(updatesPath(), "utf-8")).toBe(before);
  });
});
