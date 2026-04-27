/**
 * Tests for workspace migration `060-memory-v2-init`.
 *
 * The migration seeds the `memory/` directory tree used by the v2 memory
 * subsystem: `memory/`, `memory/concepts/`, `memory/archive/`,
 * `memory/.v2-state/`, plus an empty `edges.json` and the four prose files
 * (`essentials.md`, `threads.md`, `recent.md`, `buffer.md`). It must be
 * idempotent and must not touch existing files.
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

import { memoryV2InitMigration } from "../workspace/migrations/060-memory-v2-init.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-060-test-"));
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

/**
 * Snapshot the (relative path -> mtimeMs, content) for every file inside a
 * directory so we can assert the migration did not touch existing files.
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

describe("060-memory-v2-init migration", () => {
  test("has correct id and description", () => {
    expect(memoryV2InitMigration.id).toBe("060-memory-v2-init");
    expect(memoryV2InitMigration.description).toContain("memory/");
  });

  // ─── run() ──────────────────────────────────────────────────────────────

  test("seeds the full memory/ tree on a fresh workspace", () => {
    memoryV2InitMigration.run(workspaceDir);

    const memoryDir = join(workspaceDir, "memory");
    expect(existsSync(memoryDir)).toBe(true);
    expect(statSync(memoryDir).isDirectory()).toBe(true);

    expect(statSync(join(memoryDir, "concepts")).isDirectory()).toBe(true);
    expect(statSync(join(memoryDir, "archive")).isDirectory()).toBe(true);
    expect(statSync(join(memoryDir, ".v2-state")).isDirectory()).toBe(true);

    // edges.json is seeded with the canonical empty index.
    const edgesPath = join(memoryDir, "edges.json");
    expect(existsSync(edgesPath)).toBe(true);
    const edges = JSON.parse(readFileSync(edgesPath, "utf-8"));
    expect(edges).toEqual({ version: 1, edges: [] });

    // Each prose file is created and empty.
    for (const filename of [
      "essentials.md",
      "threads.md",
      "recent.md",
      "buffer.md",
    ]) {
      const filePath = join(memoryDir, filename);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf-8")).toBe("");
    }
  });

  test("is idempotent — second run leaves seeded files untouched", () => {
    memoryV2InitMigration.run(workspaceDir);

    const before = snapshotTree(workspaceDir);

    // Run again and verify nothing was rewritten.
    memoryV2InitMigration.run(workspaceDir);

    const after = snapshotTree(workspaceDir);

    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const [rel, prev] of Object.entries(before)) {
      expect(after[rel].content).toBe(prev.content);
      expect(after[rel].mtimeMs).toBe(prev.mtimeMs);
    }
  });

  test("preserves an existing edges.json with prior content", () => {
    const memoryDir = join(workspaceDir, "memory");
    mkdirSync(memoryDir, { recursive: true });

    const customEdges = {
      version: 1,
      edges: [
        ["alice-preferences", "bob-handoff"],
        ["bob-handoff", "team-rituals"],
      ],
    };
    const edgesPath = join(memoryDir, "edges.json");
    writeFileSync(edgesPath, JSON.stringify(customEdges, null, 2), "utf-8");

    memoryV2InitMigration.run(workspaceDir);

    const reread = JSON.parse(readFileSync(edgesPath, "utf-8"));
    expect(reread).toEqual(customEdges);
  });

  test("preserves existing prose files with content", () => {
    const memoryDir = join(workspaceDir, "memory");
    mkdirSync(memoryDir, { recursive: true });

    const essentials = "Alice's preferred IDE is VS Code.\n";
    const threads = "Follow up with Bob about the design review.\n";
    writeFileSync(join(memoryDir, "essentials.md"), essentials, "utf-8");
    writeFileSync(join(memoryDir, "threads.md"), threads, "utf-8");

    memoryV2InitMigration.run(workspaceDir);

    expect(readFileSync(join(memoryDir, "essentials.md"), "utf-8")).toBe(
      essentials,
    );
    expect(readFileSync(join(memoryDir, "threads.md"), "utf-8")).toBe(threads);
    // The other two prose files are still seeded as empty.
    expect(readFileSync(join(memoryDir, "recent.md"), "utf-8")).toBe("");
    expect(readFileSync(join(memoryDir, "buffer.md"), "utf-8")).toBe("");
  });

  test("preserves existing concept pages and archive content", () => {
    const memoryDir = join(workspaceDir, "memory");
    mkdirSync(join(memoryDir, "concepts"), { recursive: true });
    mkdirSync(join(memoryDir, "archive"), { recursive: true });

    const conceptPage = "---\nedges: []\nref_files: []\n---\n\n# Alice\n";
    writeFileSync(
      join(memoryDir, "concepts", "alice.md"),
      conceptPage,
      "utf-8",
    );
    const archiveEntry = "Bob mentioned the Q3 roadmap.\n";
    writeFileSync(
      join(memoryDir, "archive", "2026-04-01.md"),
      archiveEntry,
      "utf-8",
    );

    memoryV2InitMigration.run(workspaceDir);

    expect(readFileSync(join(memoryDir, "concepts", "alice.md"), "utf-8")).toBe(
      conceptPage,
    );
    expect(
      readFileSync(join(memoryDir, "archive", "2026-04-01.md"), "utf-8"),
    ).toBe(archiveEntry);
  });

  test("does not touch unrelated workspace files", () => {
    // Pre-populate unrelated workspace files.
    writeFileSync(
      join(workspaceDir, "config.json"),
      JSON.stringify({ hello: "world" }, null, 2),
      "utf-8",
    );
    mkdirSync(join(workspaceDir, "pkb"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "pkb", "INDEX.md"),
      "# Knowledge Base\n",
      "utf-8",
    );

    const before = snapshotTree(workspaceDir);

    memoryV2InitMigration.run(workspaceDir);

    const after = snapshotTree(workspaceDir);

    // Everything that existed before should still be there byte-for-byte.
    for (const [rel, prev] of Object.entries(before)) {
      expect(after[rel]).toBeDefined();
      expect(after[rel].content).toBe(prev.content);
      expect(after[rel].mtimeMs).toBe(prev.mtimeMs);
    }

    // Only memory/* files should be new.
    const added = Object.keys(after).filter((rel) => !(rel in before));
    for (const rel of added) {
      expect(rel.startsWith("memory/")).toBe(true);
    }
  });

  // ─── down() ─────────────────────────────────────────────────────────────

  describe("down()", () => {
    test("removes memory/.v2-state/ but preserves prose files", () => {
      memoryV2InitMigration.run(workspaceDir);

      const memoryDir = join(workspaceDir, "memory");
      // Add a fixture file inside .v2-state to verify recursive removal.
      writeFileSync(
        join(memoryDir, ".v2-state", "scratch.json"),
        "{}",
        "utf-8",
      );

      memoryV2InitMigration.down(workspaceDir);

      // .v2-state/ is gone.
      expect(existsSync(join(memoryDir, ".v2-state"))).toBe(false);

      // Prose files and edges.json remain.
      expect(existsSync(join(memoryDir, "edges.json"))).toBe(true);
      expect(existsSync(join(memoryDir, "essentials.md"))).toBe(true);
      expect(existsSync(join(memoryDir, "threads.md"))).toBe(true);
      expect(existsSync(join(memoryDir, "recent.md"))).toBe(true);
      expect(existsSync(join(memoryDir, "buffer.md"))).toBe(true);
      // concepts/ and archive/ remain.
      expect(existsSync(join(memoryDir, "concepts"))).toBe(true);
      expect(existsSync(join(memoryDir, "archive"))).toBe(true);
    });

    test("idempotent — down() twice does not throw", () => {
      memoryV2InitMigration.run(workspaceDir);
      memoryV2InitMigration.down(workspaceDir);
      memoryV2InitMigration.down(workspaceDir);
      expect(existsSync(join(workspaceDir, "memory", ".v2-state"))).toBe(false);
    });

    test("no-op when memory/.v2-state/ does not exist", () => {
      expect(existsSync(join(workspaceDir, "memory", ".v2-state"))).toBe(false);
      memoryV2InitMigration.down(workspaceDir);
      expect(existsSync(join(workspaceDir, "memory", ".v2-state"))).toBe(false);
    });
  });
});
