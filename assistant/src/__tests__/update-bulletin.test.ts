import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";

import { getWorkspacePromptPath } from "../util/platform.js";

// --- In-memory checkpoint store ---
const store = new Map<string, string>();

mock.module("../memory/checkpoints.js", () => ({
  getMemoryCheckpoint: mock((key: string) => store.get(key) ?? null),
  setMemoryCheckpoint: mock((key: string, value: string) =>
    store.set(key, value),
  ),
}));

// --- Temp directory for template files ---
// Avoids mutating the real source-controlled UPDATES.md template, preventing
// race conditions with parallel test execution and working tree corruption
// if the test process crashes.
let tempTemplateDir: string;

mock.module("../version.js", () => ({
  APP_VERSION: "1.0.0",
}));

// Mock the template path module so tests read from a temp directory instead
// of the real source-controlled template file.
mock.module("../prompts/update-bulletin-template-path.js", () => ({
  getTemplatePath: () => join(tempTemplateDir, "UPDATES.md"),
}));

const { syncUpdateBulletinOnStartup } =
  await import("../prompts/update-bulletin.js");

// Workspace path used by all tests — resolved via the preload's VELLUM_WORKSPACE_DIR.
const workspacePath = getWorkspacePromptPath("UPDATES.md");

const TEST_TEMPLATE = "## What's New\n\nTest release notes.\n";
const COMMENT_ONLY_TEMPLATE =
  "_ This is a comment-only template.\n_ No real content here.\n";

describe("syncUpdateBulletinOnStartup", () => {
  beforeEach(() => {
    store.clear();
    // Remove any leftover workspace UPDATES.md from a previous test
    if (existsSync(workspacePath)) {
      rmSync(workspacePath);
    }
    tempTemplateDir = join(
      tmpdir(),
      `update-bulletin-tpl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempTemplateDir, { recursive: true });
    // Write a test template with real content so materialization proceeds
    writeFileSync(join(tempTemplateDir, "UPDATES.md"), TEST_TEMPLATE, "utf-8");
  });

  afterEach(() => {
    // Clean up the workspace UPDATES.md so tests don't leak into each other
    if (existsSync(workspacePath)) {
      rmSync(workspacePath);
    }
    rmSync(tempTemplateDir, { recursive: true, force: true });
  });

  it("creates workspace file on first eligible run", () => {
    expect(existsSync(workspacePath)).toBe(false);

    syncUpdateBulletinOnStartup();

    expect(existsSync(workspacePath)).toBe(true);
    const content = readFileSync(workspacePath, "utf-8");
    expect(content).toContain("<!-- vellum-update-release:1.0.0 -->");
    expect(content).toContain("What's New");
  });

  it("appends release block when workspace file exists without current marker", () => {
    const preExisting =
      "<!-- vellum-update-release:0.9.0 -->\nOld release notes.\n";
    writeFileSync(workspacePath, preExisting, "utf-8");

    syncUpdateBulletinOnStartup();

    const content = readFileSync(workspacePath, "utf-8");
    expect(content).toContain("<!-- vellum-update-release:0.9.0 -->");
    expect(content).toContain("<!-- vellum-update-release:1.0.0 -->");
    expect(content).toContain("Old release notes.");
  });

  it("does not duplicate same marker on repeated runs", () => {
    syncUpdateBulletinOnStartup();
    const afterFirst = readFileSync(workspacePath, "utf-8");

    syncUpdateBulletinOnStartup();
    const afterSecond = readFileSync(workspacePath, "utf-8");

    expect(afterSecond).toBe(afterFirst);
  });

  it("skips completed release", () => {
    store.set("updates:completed_releases", JSON.stringify(["1.0.0"]));

    syncUpdateBulletinOnStartup();

    expect(existsSync(workspacePath)).toBe(false);
  });

  it("adds current release to active set", () => {
    syncUpdateBulletinOnStartup();

    const raw = store.get("updates:active_releases");
    expect(raw).toBeDefined();
    const active: string[] = JSON.parse(raw!);
    expect(active).toContain("1.0.0");
  });

  it("marks active releases as completed when UPDATES.md is deleted", () => {
    // Pre-populate active releases in the store
    store.set("updates:active_releases", JSON.stringify(["0.8.0", "0.9.0"]));

    // Workspace file does not exist — simulates the assistant having deleted it
    expect(existsSync(workspacePath)).toBe(false);

    syncUpdateBulletinOnStartup();

    // Active set should be cleared (except for the newly-added current release)
    const activeRaw = store.get("updates:active_releases");
    expect(activeRaw).toBeDefined();
    const active: string[] = JSON.parse(activeRaw!);
    // The old releases should not be in the active set
    expect(active).not.toContain("0.8.0");
    expect(active).not.toContain("0.9.0");

    // The old releases should now be completed
    const completedRaw = store.get("updates:completed_releases");
    expect(completedRaw).toBeDefined();
    const completed: string[] = JSON.parse(completedRaw!);
    expect(completed).toContain("0.8.0");
    expect(completed).toContain("0.9.0");
  });

  it("does not recreate completed release after deletion", () => {
    // First run — creates the workspace file and marks 1.0.0 active
    syncUpdateBulletinOnStartup();
    expect(existsSync(workspacePath)).toBe(true);

    // Simulate assistant deleting the file to signal completion
    rmSync(workspacePath);
    expect(existsSync(workspacePath)).toBe(false);

    // Second run — deletion-completion should mark 1.0.0 completed
    syncUpdateBulletinOnStartup();

    // The file should NOT be recreated since the release is now completed
    expect(existsSync(workspacePath)).toBe(false);
  });

  it("merges pending old block with new release block", () => {
    // Pre-create workspace file with an old release block
    const oldContent =
      "<!-- vellum-update-release:0.9.0 -->\nOld release notes for 0.9.0.\n<!-- /vellum-update-release:0.9.0 -->\n";
    writeFileSync(workspacePath, oldContent, "utf-8");

    syncUpdateBulletinOnStartup();

    const content = readFileSync(workspacePath, "utf-8");
    // Both old and new release blocks should be present
    expect(content).toContain("<!-- vellum-update-release:0.9.0 -->");
    expect(content).toContain("Old release notes for 0.9.0.");
    expect(content).toContain("<!-- vellum-update-release:1.0.0 -->");
  });

  it("idempotent on repeated sync calls", () => {
    // First call
    syncUpdateBulletinOnStartup();
    const afterFirst = readFileSync(workspacePath, "utf-8");

    // Second call
    syncUpdateBulletinOnStartup();
    const afterSecond = readFileSync(workspacePath, "utf-8");

    expect(afterSecond).toBe(afterFirst);

    // Third call for good measure
    syncUpdateBulletinOnStartup();
    const afterThird = readFileSync(workspacePath, "utf-8");

    expect(afterThird).toBe(afterFirst);
  });

  it("write path produces valid UTF-8 with trailing newline", () => {
    syncUpdateBulletinOnStartup();
    const content = readFileSync(workspacePath, "utf-8");

    expect(content.length).toBeGreaterThan(0);
    expect(content.endsWith("\n")).toBe(true);

    // Verify round-trip through Buffer produces identical content (valid UTF-8)
    const roundTripped = Buffer.from(content, "utf-8").toString("utf-8");
    expect(roundTripped).toBe(content);
  });

  it("no temp file leftovers after successful write", () => {
    syncUpdateBulletinOnStartup();

    const wsDir = process.env.VELLUM_WORKSPACE_DIR!;
    const entries = readdirSync(wsDir);
    const tmpFiles = entries.filter((e) => e.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  it("skips materialization when template is comment-only", () => {
    // Write a comment-only template fixture (no real content after stripping)
    writeFileSync(
      join(tempTemplateDir, "UPDATES.md"),
      COMMENT_ONLY_TEMPLATE,
      "utf-8",
    );
    syncUpdateBulletinOnStartup();

    expect(existsSync(workspacePath)).toBe(false);
  });

  it("only appends new content blocks on version bump with extended template", () => {
    // Workspace already has entries A and B from a prior release
    const oldContent = [
      "<!-- vellum-update-release:0.9.0 -->",
      "<!-- vellum-update-release:entry-a -->",
      "## Entry A",
      "Content for A.",
      "<!-- /vellum-update-release:entry-a -->",
      "",
      "<!-- vellum-update-release:entry-b -->",
      "## Entry B",
      "Content for B.",
      "<!-- /vellum-update-release:entry-b -->",
      "",
    ].join("\n");
    writeFileSync(workspacePath, oldContent, "utf-8");

    // Template now has A, B, C — C is the only new entry
    const extendedTemplate = [
      "<!-- vellum-update-release:entry-a -->",
      "## Entry A",
      "Content for A.",
      "<!-- /vellum-update-release:entry-a -->",
      "",
      "<!-- vellum-update-release:entry-b -->",
      "## Entry B",
      "Content for B.",
      "<!-- /vellum-update-release:entry-b -->",
      "",
      "<!-- vellum-update-release:entry-c -->",
      "## Entry C",
      "New content for C.",
      "<!-- /vellum-update-release:entry-c -->",
      "",
    ].join("\n");
    writeFileSync(
      join(tempTemplateDir, "UPDATES.md"),
      extendedTemplate,
      "utf-8",
    );

    syncUpdateBulletinOnStartup();

    const content = readFileSync(workspacePath, "utf-8");

    // New release block should be present
    expect(content).toContain("<!-- vellum-update-release:1.0.0 -->");

    // Entry C should appear
    expect(content).toContain("entry-c");
    expect(content).toContain("New content for C.");

    // Entries A and B should NOT be duplicated
    const countA = (
      content.match(/<!-- vellum-update-release:entry-a -->/g) || []
    ).length;
    const countB = (
      content.match(/<!-- vellum-update-release:entry-b -->/g) || []
    ).length;
    expect(countA).toBe(1);
    expect(countB).toBe(1);
  });

  it("skips append when all template content blocks already exist in workspace", () => {
    // Workspace already has entries A and B from a prior release
    const oldContent = [
      "<!-- vellum-update-release:0.9.0 -->",
      "<!-- vellum-update-release:entry-a -->",
      "## Entry A",
      "<!-- /vellum-update-release:entry-a -->",
      "",
      "<!-- vellum-update-release:entry-b -->",
      "## Entry B",
      "<!-- /vellum-update-release:entry-b -->",
      "",
    ].join("\n");
    writeFileSync(workspacePath, oldContent, "utf-8");

    // Template has the same A and B — nothing new
    const sameTemplate = [
      "<!-- vellum-update-release:entry-a -->",
      "## Entry A",
      "<!-- /vellum-update-release:entry-a -->",
      "",
      "<!-- vellum-update-release:entry-b -->",
      "## Entry B",
      "<!-- /vellum-update-release:entry-b -->",
      "",
    ].join("\n");
    writeFileSync(
      join(tempTemplateDir, "UPDATES.md"),
      sameTemplate,
      "utf-8",
    );

    syncUpdateBulletinOnStartup();

    const content = readFileSync(workspacePath, "utf-8");

    // No 1.0.0 block should be added — all content already present
    expect(content).not.toContain("<!-- vellum-update-release:1.0.0 -->");
  });

  it("preserves existing file when atomic write fails", () => {
    const originalContent =
      "<!-- vellum-update-release:0.9.0 -->\nOriginal content.\n";
    writeFileSync(workspacePath, originalContent, "utf-8");

    // Mock writeFileSync to throw when writing the temp file, simulating a
    // disk-full or permission error deterministically (chmod-based approaches
    // are unreliable when running as root or with CAP_DAC_OVERRIDE).
    const originalWriteFileSync = fs.writeFileSync;
    const spy = spyOn(fs, "writeFileSync").mockImplementation(
      (...args: Parameters<typeof fs.writeFileSync>) => {
        if (typeof args[0] === "string" && args[0].includes(".tmp.")) {
          throw new Error("Simulated write failure");
        }
        return originalWriteFileSync(...args);
      },
    );
    try {
      expect(() => syncUpdateBulletinOnStartup()).toThrow(
        "Simulated write failure",
      );
    } finally {
      spy.mockRestore();
    }

    // Original content should be preserved (atomic write never renamed over it)
    const content = readFileSync(workspacePath, "utf-8");
    expect(content).toBe(originalContent);

    // No temp file leftovers
    const wsDir = process.env.VELLUM_WORKSPACE_DIR!;
    const entries = readdirSync(wsDir);
    const tmpFiles = entries.filter((e: string) => e.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });
});
