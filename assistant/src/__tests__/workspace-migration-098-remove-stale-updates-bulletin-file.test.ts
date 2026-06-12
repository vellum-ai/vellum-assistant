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

import { removeStaleUpdatesBulletinFileMigration } from "../workspace/migrations/098-remove-stale-updates-bulletin-file.js";

const RELEASE_NOTES_CONTENT = `<!-- release-note-id:078-release-notes-tavily-web-search -->
## Web search

The assistant can now search the web via Tavily.
`;

const QUARANTINE_CONTENT = `## Config was reset to defaults

Your \`config.json\` was unreadable at 2026-01-01T00:00:00.000Z and couldn't be
parsed as JSON.

<!-- config-quarantine:config.json.corrupt-2026-01-01T00-00-00-000Z.json -->
`;

let testRoot: string;
let workspaceDir: string;

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "migration-098-remove-updates-"));
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

describe("098-remove-stale-updates-bulletin-file", () => {
  test("deletes UPDATES.md containing only release notes", () => {
    writeFileSync(updatesPath(), RELEASE_NOTES_CONTENT, "utf-8");

    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(false);
  });

  test("no-ops when UPDATES.md is absent", () => {
    expect(() =>
      removeStaleUpdatesBulletinFileMigration.run(workspaceDir),
    ).not.toThrow();
    expect(existsSync(updatesPath())).toBe(false);
  });

  test("preserves a file without release-note markers (user-repurposed)", () => {
    const userContent = "# My own notes\n\nThe user repurposed this file.\n";
    writeFileSync(updatesPath(), userContent, "utf-8");

    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(true);
    expect(readFileSync(updatesPath(), "utf-8")).toBe(userContent);
  });

  test("preserves a file containing a config-quarantine note", () => {
    const mixed = `${RELEASE_NOTES_CONTENT}\n${QUARANTINE_CONTENT}`;
    writeFileSync(updatesPath(), mixed, "utf-8");

    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(true);
    expect(readFileSync(updatesPath(), "utf-8")).toBe(mixed);
  });

  test("is idempotent", () => {
    writeFileSync(updatesPath(), RELEASE_NOTES_CONTENT, "utf-8");

    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);
    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(false);
  });
});
