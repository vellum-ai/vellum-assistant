import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { parse as parseYaml } from "yaml";

import { backfillLeafIdsMigration } from "../093-backfill-leaf-ids.js";

const LEAVES_REL = join("memory", "v3", "data", "leaves");

function leafPath(workspaceDir: string, rel: string): string {
  return join(workspaceDir, LEAVES_REL, rel);
}

function writeLeaf(
  workspaceDir: string,
  rel: string,
  frontmatter: Record<string, unknown>,
  body: string,
): void {
  const full = leafPath(workspaceDir, rel);
  mkdirSync(dirname(full), { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  writeFileSync(full, `---\n${fm}\n---\n${body}`, "utf8");
}

function readLeaf(
  workspaceDir: string,
  rel: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const raw = readFileSync(leafPath(workspaceDir, rel), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`leaf ${rel} lost its frontmatter`);
  return {
    frontmatter: parseYaml(match[1]) as Record<string, unknown>,
    body: match[2],
  };
}

describe("093-backfill-leaf-ids migration", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "backfill-leaf-ids-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("is a no-op when the leaves dir is absent", () => {
    expect(() => backfillLeafIdsMigration.run(workspaceDir)).not.toThrow();
  });

  it("backfills a stable, unique id into every leaf lacking one", () => {
    writeLeaf(
      workspaceDir,
      "domain-a/topic-x.md",
      { path: "domain-a/topic-x", in_core: true },
      "First leaf description.\n",
    );
    writeLeaf(
      workspaceDir,
      "domain-b/nested/topic-y.md",
      { path: "domain-b/nested/topic-y", in_core: false },
      "Second leaf description.\n",
    );

    backfillLeafIdsMigration.run(workspaceDir);

    const a = readLeaf(workspaceDir, "domain-a/topic-x.md");
    const b = readLeaf(workspaceDir, "domain-b/nested/topic-y.md");

    expect(typeof a.frontmatter.id).toBe("string");
    expect(typeof b.frontmatter.id).toBe("string");
    expect(a.frontmatter.id).not.toBe(b.frontmatter.id);

    // Preserves other frontmatter fields and the body.
    expect(a.frontmatter.path).toBe("domain-a/topic-x");
    expect(a.frontmatter.in_core).toBe(true);
    expect(a.body).toBe("First leaf description.\n");
    expect(b.frontmatter.in_core).toBe(false);
    expect(b.body).toBe("Second leaf description.\n");
  });

  it("leaves pre-existing ids untouched", () => {
    writeLeaf(
      workspaceDir,
      "domain-a/topic-x.md",
      { path: "domain-a/topic-x", in_core: true, id: "preexisting01" },
      "Body.\n",
    );

    backfillLeafIdsMigration.run(workspaceDir);

    expect(readLeaf(workspaceDir, "domain-a/topic-x.md").frontmatter.id).toBe(
      "preexisting01",
    );
  });

  it("is idempotent and deterministic across re-runs", () => {
    writeLeaf(
      workspaceDir,
      "domain-a/topic-x.md",
      { path: "domain-a/topic-x", in_core: true },
      "Body.\n",
    );

    backfillLeafIdsMigration.run(workspaceDir);
    const firstRaw = readFileSync(
      leafPath(workspaceDir, "domain-a/topic-x.md"),
      "utf8",
    );

    backfillLeafIdsMigration.run(workspaceDir);
    const secondRaw = readFileSync(
      leafPath(workspaceDir, "domain-a/topic-x.md"),
      "utf8",
    );

    // Re-run rewrites nothing — same id, byte-for-byte identical file.
    expect(secondRaw).toBe(firstRaw);
  });

  it("generates the same id for the same relative path (stable)", () => {
    writeLeaf(
      workspaceDir,
      "domain-a/topic-x.md",
      { path: "domain-a/topic-x", in_core: true },
      "Body.\n",
    );
    backfillLeafIdsMigration.run(workspaceDir);
    const idA = readLeaf(workspaceDir, "domain-a/topic-x.md").frontmatter.id;

    const other = mkdtempSync(join(tmpdir(), "backfill-leaf-ids-2-"));
    try {
      writeLeaf(
        other,
        "domain-a/topic-x.md",
        { path: "domain-a/topic-x", in_core: false },
        "Different body.\n",
      );
      backfillLeafIdsMigration.run(other);
      expect(readLeaf(other, "domain-a/topic-x.md").frontmatter.id).toBe(idA);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("down is a no-op that preserves backfilled ids", () => {
    writeLeaf(
      workspaceDir,
      "domain-a/topic-x.md",
      { path: "domain-a/topic-x", in_core: true },
      "Body.\n",
    );
    backfillLeafIdsMigration.run(workspaceDir);
    const id = readLeaf(workspaceDir, "domain-a/topic-x.md").frontmatter.id;

    backfillLeafIdsMigration.down(workspaceDir);

    expect(readLeaf(workspaceDir, "domain-a/topic-x.md").frontmatter.id).toBe(
      id,
    );
  });
});
