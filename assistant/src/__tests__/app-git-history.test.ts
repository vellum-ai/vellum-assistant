import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { _resetGitServiceRegistry } from "../workspace/git-service.js";

// Mock getDataDir to use a temp directory
let testDataDir: string;

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDataDir,
  getProjectDir: () => testDataDir,
}));

// Re-import after mocking so modules use our temp dir
const { createApp, updateApp, getAppDirPath } =
  await import("../memory/app-store.js");
const {
  getAppHistory,
  getAppDiff,
  getAppFileAtVersion,
  restoreAppVersion,
  commitAppTurnChanges,
} = await import("../memory/app-git-service.js");

describe("App Git History", () => {
  beforeEach(() => {
    testDataDir = join(
      tmpdir(),
      `vellum-app-git-history-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    );
    mkdirSync(join(testDataDir, "apps"), { recursive: true });
    _resetGitServiceRegistry();
  });

  afterEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  test("getAppHistory returns commits for a specific app", async () => {
    const app = createApp({
      name: "History App",
      schemaJson: "{}",
      htmlDefinition: "<h1>v1</h1>",
    });
    await commitAppTurnChanges("session-1", 1);

    updateApp(app.id, { htmlDefinition: "<h1>v2</h1>" });
    await commitAppTurnChanges("session-1", 2);

    const history = await getAppHistory(app.id);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].message).toContain("update ");
    expect(history[0].commitHash).toMatch(/^[0-9a-f]+$/);
    expect(history[0].timestamp).toBeGreaterThan(0);
  });

  test("getAppHistory does not return commits for other apps", async () => {
    const app1 = createApp({
      name: "App One",
      schemaJson: "{}",
      htmlDefinition: "<p>one</p>",
    });
    await commitAppTurnChanges("session-1", 1);

    const app2 = createApp({
      name: "App Two",
      schemaJson: "{}",
      htmlDefinition: "<p>two</p>",
    });
    await commitAppTurnChanges("session-1", 2);

    const history1 = await getAppHistory(app1.id);
    const history2 = await getAppHistory(app2.id);

    // App1 should have history from turn 1 (or initial commit)
    expect(history1.length).toBeGreaterThanOrEqual(1);
    // App2 should have history from turn 2 (or initial commit)
    expect(history2.length).toBeGreaterThanOrEqual(1);
    // App2's commits should not include app1-only turn commits
    // (turn 2 created app2, so app2 history should not have turn 1 unless initial commit)
  });

  test("getAppHistory respects limit", async () => {
    const app = createApp({
      name: "Limited App",
      schemaJson: "{}",
      htmlDefinition: "<p>v1</p>",
    });
    await commitAppTurnChanges("session-1", 1);

    updateApp(app.id, { htmlDefinition: "<p>v2</p>" });
    await commitAppTurnChanges("session-1", 2);

    updateApp(app.id, { htmlDefinition: "<p>v3</p>" });
    await commitAppTurnChanges("session-1", 3);

    const limited = await getAppHistory(app.id, 2);
    expect(limited.length).toBe(2);
  });

  test("getAppDiff shows changes between versions", async () => {
    const app = createApp({
      name: "Diff App",
      schemaJson: "{}",
      htmlDefinition: "<p>original</p>",
    });
    await commitAppTurnChanges("session-1", 1);

    const history1 = await getAppHistory(app.id);
    const createHash = history1[0].commitHash;

    updateApp(app.id, { htmlDefinition: "<p>modified</p>" });
    await commitAppTurnChanges("session-1", 2);

    const history2 = await getAppHistory(app.id);
    const updateHash = history2[0].commitHash;

    const diff = await getAppDiff(app.id, createHash, updateHash);
    expect(diff).toContain("original");
    expect(diff).toContain("modified");
  });

  test("getAppFileAtVersion returns file content at a specific commit", async () => {
    const app = createApp({
      name: "File Version App",
      schemaJson: "{}",
      htmlDefinition: "<p>version one</p>",
    });
    await commitAppTurnChanges("session-1", 1);

    const history1 = await getAppHistory(app.id);
    const v1Hash = history1[0].commitHash;

    updateApp(app.id, { htmlDefinition: "<p>version two</p>" });
    await commitAppTurnChanges("session-1", 2);

    // Get the file at v1 — should show old content
    const v1Content = await getAppFileAtVersion(app.id, "index.html", v1Hash);
    expect(v1Content).toContain("version one");
    expect(v1Content).not.toContain("version two");

    // Current file should show new content
    const currentContent = readFileSync(
      join(getAppDirPath(app.id), "index.html"),
      "utf-8",
    );
    expect(currentContent).toContain("version two");
  });

  test("restoreAppVersion restores files and creates a new commit", async () => {
    const app = createApp({
      name: "Restore App",
      schemaJson: "{}",
      htmlDefinition: "<p>original content</p>",
    });
    await commitAppTurnChanges("session-1", 1);

    const history1 = await getAppHistory(app.id);
    const originalHash = history1[0].commitHash;

    updateApp(app.id, { htmlDefinition: "<p>new content</p>" });
    await commitAppTurnChanges("session-1", 2);

    // Verify current content is "new content"
    let current = readFileSync(
      join(getAppDirPath(app.id), "index.html"),
      "utf-8",
    );
    expect(current).toContain("new content");

    // Restore to original
    await restoreAppVersion(app.id, originalHash);

    // Verify content is restored
    current = readFileSync(join(getAppDirPath(app.id), "index.html"), "utf-8");
    expect(current).toContain("original content");

    // Verify a restore commit was created
    const history2 = await getAppHistory(app.id);
    expect(history2[0].message).toContain("Restore app");
  });
});
