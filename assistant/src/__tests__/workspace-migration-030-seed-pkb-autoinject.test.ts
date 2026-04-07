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

import { seedPkbAutoinjectMigration } from "../workspace/migrations/030-seed-pkb-autoinject.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;
let pkbDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-030-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  pkbDir = join(workspaceDir, "pkb");
  mkdirSync(pkbDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

const dirs: string[] = [];

beforeEach(() => {
  freshWorkspace();
  dirs.push(workspaceDir);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("030-seed-pkb-autoinject migration", () => {
  test("has correct migration id", () => {
    expect(seedPkbAutoinjectMigration.id).toBe("030-seed-pkb-autoinject");
  });

  // ─── run() ──────────────────────────────────────────────────────────────

  test("creates _autoinject.md with default content", () => {
    seedPkbAutoinjectMigration.run(workspaceDir);

    const filePath = join(pkbDir, "_autoinject.md");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("INDEX.md");
    expect(content).toContain("essentials.md");
    expect(content).toContain("threads.md");
    expect(content).toContain("buffer.md");
  });

  test("no-op when pkb/ does not exist", () => {
    rmSync(pkbDir, { recursive: true, force: true });
    seedPkbAutoinjectMigration.run(workspaceDir);
    expect(existsSync(join(pkbDir, "_autoinject.md"))).toBe(false);
  });

  test("idempotent — does not overwrite existing _autoinject.md", () => {
    const customContent = "INDEX.md\ncustom-topic.md\n";
    writeFileSync(join(pkbDir, "_autoinject.md"), customContent, "utf-8");

    seedPkbAutoinjectMigration.run(workspaceDir);

    const content = readFileSync(join(pkbDir, "_autoinject.md"), "utf-8");
    expect(content).toBe(customContent);
  });

  test("appends _autoinject.md entry to INDEX.md", () => {
    const indexContent =
      "# Knowledge Base\n\n## Always Loaded\n" +
      "- essentials.md — Core facts\n" +
      "- threads.md — Active threads\n" +
      "- buffer.md — Inbox\n\n" +
      "## Topics\n";
    writeFileSync(join(pkbDir, "INDEX.md"), indexContent, "utf-8");

    seedPkbAutoinjectMigration.run(workspaceDir);

    const updated = readFileSync(join(pkbDir, "INDEX.md"), "utf-8");
    expect(updated).toContain("_autoinject.md");
    // Should appear after buffer.md
    const bufferIdx = updated.indexOf("buffer.md");
    const autoinjectIdx = updated.indexOf("_autoinject.md");
    expect(autoinjectIdx).toBeGreaterThan(bufferIdx);
  });

  test("does not duplicate _autoinject.md entry in INDEX.md", () => {
    const indexContent =
      "# Knowledge Base\n\n## Always Loaded\n" +
      "- buffer.md — Inbox\n" +
      "- _autoinject.md — Controls autoinjection\n\n" +
      "## Topics\n";
    writeFileSync(join(pkbDir, "INDEX.md"), indexContent, "utf-8");

    seedPkbAutoinjectMigration.run(workspaceDir);

    const updated = readFileSync(join(pkbDir, "INDEX.md"), "utf-8");
    const matches = updated.match(/_autoinject\.md/g);
    expect(matches?.length).toBe(1);
  });

  test("handles missing INDEX.md gracefully", () => {
    // No INDEX.md — should still create _autoinject.md without error
    seedPkbAutoinjectMigration.run(workspaceDir);
    expect(existsSync(join(pkbDir, "_autoinject.md"))).toBe(true);
  });

  // ─── down() ─────────────────────────────────────────────────────────────

  describe("down()", () => {
    test("removes _autoinject.md when content matches template", () => {
      seedPkbAutoinjectMigration.run(workspaceDir);
      expect(existsSync(join(pkbDir, "_autoinject.md"))).toBe(true);

      seedPkbAutoinjectMigration.down(workspaceDir);
      expect(existsSync(join(pkbDir, "_autoinject.md"))).toBe(false);
    });

    test("preserves _autoinject.md when user has customized it", () => {
      const customContent = "INDEX.md\nmy-custom-file.md\n";
      writeFileSync(join(pkbDir, "_autoinject.md"), customContent, "utf-8");

      seedPkbAutoinjectMigration.down(workspaceDir);

      expect(existsSync(join(pkbDir, "_autoinject.md"))).toBe(true);
      expect(readFileSync(join(pkbDir, "_autoinject.md"), "utf-8")).toBe(
        customContent,
      );
    });

    test("no-op when _autoinject.md does not exist", () => {
      seedPkbAutoinjectMigration.down(workspaceDir);
      // Should not throw
    });

    test("no-op when pkb/ does not exist", () => {
      rmSync(pkbDir, { recursive: true, force: true });
      seedPkbAutoinjectMigration.down(workspaceDir);
      // Should not throw
    });

    test("idempotent — calling down() twice is safe", () => {
      seedPkbAutoinjectMigration.run(workspaceDir);
      seedPkbAutoinjectMigration.down(workspaceDir);
      seedPkbAutoinjectMigration.down(workspaceDir);
      // Should not throw
    });
  });
});
