/**
 * Tests for workspace migration `062-drop-memory-v2-edges-json`.
 *
 * Removes the legacy `memory/edges.json` file from any workspace seeded by
 * an older revision of `060-memory-v2-init`. Outgoing edges now live in
 * concept-page frontmatter, so the index file is no longer read by anything.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dropMemoryV2EdgesJsonMigration } from "../workspace/migrations/062-drop-memory-v2-edges-json.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-062-test-"));
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("062-drop-memory-v2-edges-json migration", () => {
  test("has correct id and description", () => {
    expect(dropMemoryV2EdgesJsonMigration.id).toBe(
      "062-drop-memory-v2-edges-json",
    );
    expect(dropMemoryV2EdgesJsonMigration.description).toContain("edges.json");
  });

  test("deletes memory/edges.json when present", () => {
    const memoryDir = join(workspaceDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    const edgesPath = join(memoryDir, "edges.json");
    writeFileSync(
      edgesPath,
      JSON.stringify({ version: 1, edges: [] }, null, 2),
      "utf-8",
    );

    dropMemoryV2EdgesJsonMigration.run(workspaceDir);

    expect(existsSync(edgesPath)).toBe(false);
  });

  test("is a no-op when memory/edges.json is absent", () => {
    expect(existsSync(join(workspaceDir, "memory", "edges.json"))).toBe(false);
    expect(() =>
      dropMemoryV2EdgesJsonMigration.run(workspaceDir),
    ).not.toThrow();
  });

  test("is idempotent — running twice does not throw", () => {
    const memoryDir = join(workspaceDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "edges.json"), "{}", "utf-8");

    dropMemoryV2EdgesJsonMigration.run(workspaceDir);
    expect(() =>
      dropMemoryV2EdgesJsonMigration.run(workspaceDir),
    ).not.toThrow();
  });

  test("does not touch sibling files in memory/", () => {
    const memoryDir = join(workspaceDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(memoryDir, "edges.json"),
      JSON.stringify({ version: 1, edges: [] }),
      "utf-8",
    );
    writeFileSync(
      join(memoryDir, "essentials.md"),
      "Alice's preferred IDE is VS Code.\n",
      "utf-8",
    );

    dropMemoryV2EdgesJsonMigration.run(workspaceDir);

    expect(existsSync(join(memoryDir, "edges.json"))).toBe(false);
    expect(readFileSync(join(memoryDir, "essentials.md"), "utf-8")).toBe(
      "Alice's preferred IDE is VS Code.\n",
    );
  });

  test("down() is a no-op", () => {
    expect(() =>
      dropMemoryV2EdgesJsonMigration.down(workspaceDir),
    ).not.toThrow();
  });
});
