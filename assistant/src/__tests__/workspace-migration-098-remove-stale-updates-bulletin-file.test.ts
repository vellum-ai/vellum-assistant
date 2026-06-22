import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

import { releaseNotesTavilyWebSearchMigration } from "../workspace/migrations/078-release-notes-tavily-web-search.js";
import { removeStaleUpdatesBulletinFileMigration } from "../workspace/migrations/098-remove-stale-updates-bulletin-file.js";

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
  test("deletes a leftover UPDATES.md", () => {
    releaseNotesTavilyWebSearchMigration.run(workspaceDir);
    expect(existsSync(updatesPath())).toBe(true);

    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(false);
  });

  test("no-ops when UPDATES.md is absent", () => {
    expect(() =>
      removeStaleUpdatesBulletinFileMigration.run(workspaceDir),
    ).not.toThrow();
    expect(existsSync(updatesPath())).toBe(false);
  });

  test("is idempotent", () => {
    writeFileSync(updatesPath(), "anything\n", "utf-8");

    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);
    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(false);
  });
});
