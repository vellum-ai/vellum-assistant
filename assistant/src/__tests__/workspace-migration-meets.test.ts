/**
 * Tests for workspace migration `037-create-meets-dir`.
 *
 * The migration creates `<workspace>/meets/` (if missing) and seeds a
 * `.keep` sentinel file. It must be idempotent and must not touch other
 * workspace files.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createMeetsDirMigration } from "../workspace/migrations/037-create-meets-dir.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-037-test-"));
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

/**
 * Snapshot the (relative path -> mtimeMs, content) for every file inside a
 * directory so we can assert a migration did not touch it.
 */
function snapshotTree(
  root: string,
): Record<string, { mtimeMs: number; content: string }> {
  const out: Record<string, { mtimeMs: number; content: string }> = {};
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const rel = abs.slice(root.length + 1);
        out[rel] = {
          mtimeMs: statSync(abs).mtimeMs,
          content: readFileSync(abs, "utf-8"),
        };
      }
    }
  }
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("037-create-meets-dir migration", () => {
  test("has correct id and description", () => {
    expect(createMeetsDirMigration.id).toBe("037-create-meets-dir");
    expect(createMeetsDirMigration.description).toContain("meets/");
  });

  test("creates meets/ with .keep sentinel file on a fresh workspace", () => {
    createMeetsDirMigration.run(workspaceDir);

    const meetsDir = join(workspaceDir, "meets");
    expect(existsSync(meetsDir)).toBe(true);
    expect(statSync(meetsDir).isDirectory()).toBe(true);

    const keepPath = join(meetsDir, ".keep");
    expect(existsSync(keepPath)).toBe(true);
    expect(statSync(keepPath).isFile()).toBe(true);
  });

  test("is idempotent — running twice does not error and does not overwrite .keep", () => {
    createMeetsDirMigration.run(workspaceDir);

    const keepPath = join(workspaceDir, "meets", ".keep");
    expect(existsSync(keepPath)).toBe(true);

    const firstContent = readFileSync(keepPath, "utf-8");
    const firstMtime = statSync(keepPath).mtimeMs;

    // Second run — should not throw, should not rewrite the .keep file.
    createMeetsDirMigration.run(workspaceDir);

    expect(existsSync(keepPath)).toBe(true);
    expect(readFileSync(keepPath, "utf-8")).toBe(firstContent);
    expect(statSync(keepPath).mtimeMs).toBe(firstMtime);
  });

  test("does not error when meets/ already exists with user content", () => {
    // Simulate a pre-existing meets/ directory with a user meeting inside.
    const meetsDir = join(workspaceDir, "meets");
    const meetingDir = join(meetsDir, "meeting-abc");
    mkdirSync(meetingDir, { recursive: true });
    writeFileSync(join(meetingDir, "meta.json"), "{}", "utf-8");

    createMeetsDirMigration.run(workspaceDir);

    // Pre-existing content is preserved.
    expect(existsSync(join(meetingDir, "meta.json"))).toBe(true);
    expect(readFileSync(join(meetingDir, "meta.json"), "utf-8")).toBe("{}");

    // .keep sentinel was added at the meets/ root.
    expect(existsSync(join(meetsDir, ".keep"))).toBe(true);
  });

  test("does not overwrite a user-customized .keep file", () => {
    const meetsDir = join(workspaceDir, "meets");
    mkdirSync(meetsDir, { recursive: true });
    const keepPath = join(meetsDir, ".keep");
    const customContent = "# my notes about meets/\n";
    writeFileSync(keepPath, customContent, "utf-8");

    createMeetsDirMigration.run(workspaceDir);

    expect(readFileSync(keepPath, "utf-8")).toBe(customContent);
  });

  test("does not touch other workspace files", () => {
    // Pre-populate unrelated workspace files.
    writeFileSync(
      join(workspaceDir, "config.json"),
      JSON.stringify({ hello: "world" }, null, 2),
      "utf-8",
    );
    mkdirSync(join(workspaceDir, "users"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "users", "guardian.md"),
      "# Guardian\n",
      "utf-8",
    );
    mkdirSync(join(workspaceDir, "pkb"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "pkb", "INDEX.md"),
      "# Knowledge Base\n",
      "utf-8",
    );

    const before = snapshotTree(workspaceDir);

    createMeetsDirMigration.run(workspaceDir);

    const after = snapshotTree(workspaceDir);

    // Everything that existed before should still exist with identical
    // content and mtime (nothing touched).
    for (const [rel, prev] of Object.entries(before)) {
      expect(after[rel]).toBeDefined();
      expect(after[rel].content).toBe(prev.content);
      expect(after[rel].mtimeMs).toBe(prev.mtimeMs);
    }

    // Only the .keep under meets/ should be new.
    const added = Object.keys(after).filter((rel) => !(rel in before));
    expect(added).toEqual([join("meets", ".keep")]);
  });

  test("second run on a populated meets/ leaves user content untouched", () => {
    createMeetsDirMigration.run(workspaceDir);

    const meetsDir = join(workspaceDir, "meets");
    const meetingDir = join(meetsDir, "meeting-xyz");
    mkdirSync(meetingDir, { recursive: true });
    const transcriptPath = join(meetingDir, "transcript.jsonl");
    writeFileSync(transcriptPath, '{"t":0,"text":"hello"}\n', "utf-8");
    const before = snapshotTree(workspaceDir);

    createMeetsDirMigration.run(workspaceDir);

    const after = snapshotTree(workspaceDir);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const [rel, prev] of Object.entries(before)) {
      expect(after[rel].content).toBe(prev.content);
      expect(after[rel].mtimeMs).toBe(prev.mtimeMs);
    }
  });

  // ─── down() ─────────────────────────────────────────────────────────────

  describe("down()", () => {
    test("removes seeded .keep and empty meets/ directory after a forward run", () => {
      createMeetsDirMigration.run(workspaceDir);
      expect(existsSync(join(workspaceDir, "meets", ".keep"))).toBe(true);

      createMeetsDirMigration.down(workspaceDir);

      expect(existsSync(join(workspaceDir, "meets", ".keep"))).toBe(false);
      expect(existsSync(join(workspaceDir, "meets"))).toBe(false);
    });

    test("preserves user-created meeting content on down()", () => {
      createMeetsDirMigration.run(workspaceDir);

      const meetsDir = join(workspaceDir, "meets");
      const meetingDir = join(meetsDir, "meeting-abc");
      mkdirSync(meetingDir, { recursive: true });
      writeFileSync(join(meetingDir, "meta.json"), "{}", "utf-8");

      createMeetsDirMigration.down(workspaceDir);

      // .keep is removed but user content and the meets/ dir itself remain
      // since the directory is non-empty.
      expect(existsSync(join(meetsDir, ".keep"))).toBe(false);
      expect(existsSync(meetsDir)).toBe(true);
      expect(existsSync(join(meetingDir, "meta.json"))).toBe(true);
    });

    test("idempotent — down() twice does not throw", () => {
      createMeetsDirMigration.run(workspaceDir);
      createMeetsDirMigration.down(workspaceDir);
      // Second call — should not throw.
      createMeetsDirMigration.down(workspaceDir);
      expect(existsSync(join(workspaceDir, "meets"))).toBe(false);
    });

    test("no-op when meets/ does not exist", () => {
      expect(existsSync(join(workspaceDir, "meets"))).toBe(false);
      createMeetsDirMigration.down(workspaceDir);
      // Should not throw and should not create anything.
      expect(existsSync(join(workspaceDir, "meets"))).toBe(false);
    });
  });
});
