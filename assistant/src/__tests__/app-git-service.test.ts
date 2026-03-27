import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { commitAppTurnChanges } from "../memory/app-git-service.js";
import { _resetGitServiceRegistry } from "../workspace/git-service.js";

// Mock getDataDir to use a temp directory
let testDataDir: string;

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDataDir,
  getProjectDir: () => testDataDir,
}));

// Re-import app-store after mocking so it uses our temp dir
const {
  createApp,
  updateApp,
  deleteApp,
  writeAppFile,
  editAppFile,
  getAppsDir,
} = await import("../memory/app-store.js");

describe("App Git Service", () => {
  beforeEach(() => {
    testDataDir = join(
      tmpdir(),
      `vellum-app-git-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testDataDir, "apps"), { recursive: true });
    _resetGitServiceRegistry();
  });

  afterEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  function getGitLog(dir: string): string[] {
    try {
      const output = execFileSync("git", ["log", "--oneline", "--format=%s"], {
        cwd: dir,
        encoding: "utf-8",
      });
      return output.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  test(".gitignore excludes preview files and records", async () => {
    const appsDir = getAppsDir();
    await commitAppTurnChanges("test-session", 1);

    const gitignore = readFileSync(join(appsDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain("*.preview");
    expect(gitignore).toContain("*/records/");
  });

  test("mutations do not auto-commit", async () => {
    createApp({
      name: "Test App",
      schemaJson: "{}",
      htmlDefinition: "<h1>Hello</h1>",
    });

    // Wait to make sure no fire-and-forget commit happens
    await new Promise((resolve) => setTimeout(resolve, 500));

    const appsDir = getAppsDir();
    // No git repo should exist yet since no turn commit was triggered
    expect(existsSync(join(appsDir, ".git"))).toBe(false);
  });

  test("commitAppTurnChanges creates a single commit for multiple mutations", async () => {
    const app = createApp({
      name: "Multi Edit App",
      schemaJson: "{}",
      htmlDefinition: "<p>v1</p>",
    });

    updateApp(app.id, { htmlDefinition: "<p>v2</p>" });
    writeAppFile(app.id, "styles.css", "body { color: red; }");
    editAppFile(app.id, "index.html", "v2", "v3");

    // All mutations happened, now commit at turn boundary
    await commitAppTurnChanges("session-1", 1);

    const appsDir = getAppsDir();
    const commits = getGitLog(appsDir);

    // On a fresh repo the first turn's files may be absorbed into the
    // "Initial commit" created by WorkspaceGitService.ensureInitialized.
    // Either way there should be at most 2 commits, not one per mutation.
    expect(commits.length).toBeLessThanOrEqual(2);
    // The turn commit message should appear (or files are in the initial commit)
    expect(
      commits.some(
        (c) => c.includes("update ") || c.includes("Initial commit"),
      ),
    ).toBe(true);
  });

  test("commitAppTurnChanges does not commit when nothing changed", async () => {
    // Trigger initial commit by creating and committing an app
    createApp({
      name: "Static App",
      schemaJson: "{}",
      htmlDefinition: "<p>hi</p>",
    });
    await commitAppTurnChanges("session-1", 1);

    const appsDir = getAppsDir();
    const commitsBefore = getGitLog(appsDir);

    // No mutations — turn commit should be a no-op
    await commitAppTurnChanges("session-1", 2);

    const commitsAfter = getGitLog(appsDir);
    expect(commitsAfter.length).toBe(commitsBefore.length);
  });

  test("commitAppTurnChanges swallows errors gracefully", async () => {
    // This should not throw
    await commitAppTurnChanges("test", 1);
  });

  test("deleteApp changes are captured by turn commit", async () => {
    const app = createApp({
      name: "Doomed App",
      schemaJson: "{}",
      htmlDefinition: "<p>bye</p>",
    });
    await commitAppTurnChanges("session-1", 1);

    deleteApp(app.id);
    await commitAppTurnChanges("session-1", 2);

    const appsDir = getAppsDir();
    const commits = getGitLog(appsDir);
    expect(commits[0]).toContain("update ");
  });
});
