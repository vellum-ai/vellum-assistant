import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { moveMemoryTreeOutOfV3Migration } from "../workspace/migrations/089-move-memory-tree-out-of-v3.js";

describe("workspace migration 089 — move memory tree out of v3", () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(join(tmpdir(), "ws-mig-089-"));
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  function writeOldTree(): void {
    const oldTree = join(ws, "memory", "v3", "tree");
    fs.mkdirSync(join(oldTree, "people"), { recursive: true });
    fs.writeFileSync(join(oldTree, "_root.md"), "root");
    fs.writeFileSync(join(oldTree, "people", "alice.md"), "alice");
  }

  test("moves memory/v3/tree -> memory/tree (incl. nested) and drops the empty v3 wrapper", () => {
    writeOldTree();
    moveMemoryTreeOutOfV3Migration.run(ws);

    expect(fs.existsSync(join(ws, "memory", "v3"))).toBe(false);
    expect(
      fs.readFileSync(join(ws, "memory", "tree", "_root.md"), "utf-8"),
    ).toBe("root");
    expect(
      fs.readFileSync(
        join(ws, "memory", "tree", "people", "alice.md"),
        "utf-8",
      ),
    ).toBe("alice");
  });

  test("is idempotent — re-running after the move changes nothing", () => {
    writeOldTree();
    moveMemoryTreeOutOfV3Migration.run(ws);
    moveMemoryTreeOutOfV3Migration.run(ws);

    expect(
      fs.readFileSync(join(ws, "memory", "tree", "_root.md"), "utf-8"),
    ).toBe("root");
  });

  test("no-op on a fresh workspace with no old tree", () => {
    moveMemoryTreeOutOfV3Migration.run(ws);
    expect(fs.existsSync(join(ws, "memory", "tree"))).toBe(false);
  });

  test("never clobbers an existing memory/tree", () => {
    writeOldTree();
    const newTree = join(ws, "memory", "tree");
    fs.mkdirSync(newTree, { recursive: true });
    fs.writeFileSync(join(newTree, "_root.md"), "existing");

    moveMemoryTreeOutOfV3Migration.run(ws);

    // Destination preserved; source left in place for manual resolution.
    expect(fs.readFileSync(join(newTree, "_root.md"), "utf-8")).toBe(
      "existing",
    );
    expect(fs.existsSync(join(ws, "memory", "v3", "tree", "_root.md"))).toBe(
      true,
    );
  });

  test("down() restores memory/tree back to memory/v3/tree", () => {
    const newTree = join(ws, "memory", "tree");
    fs.mkdirSync(newTree, { recursive: true });
    fs.writeFileSync(join(newTree, "_root.md"), "root");

    moveMemoryTreeOutOfV3Migration.down(ws);

    expect(fs.existsSync(join(ws, "memory", "tree"))).toBe(false);
    expect(
      fs.readFileSync(join(ws, "memory", "v3", "tree", "_root.md"), "utf-8"),
    ).toBe("root");
  });
});
