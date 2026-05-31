import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Provider } from "../../../providers/types.js";
import { readPage, writePage } from "../../v2/page-store.js";
import { type LeafRef, reconcileTree } from "../reconcile.js";

/**
 * A canned provider whose `assign_leaves` tool-use response is computed from
 * the user message (the page content) via `idsForMessage`. This lets a test
 * deterministically re-home each page onto specific surviving leaves without a
 * real LLM. The leaf index in the system prompt is sorted by path; tests pass
 * the 1-based id of the target leaf in that sorted order.
 */
function stubProvider(
  idsForMessage: (message: string, systemPrompt: string) => number[],
): Provider {
  return {
    name: "stub",
    async sendMessage(messages: unknown, opts: unknown) {
      const msg = messages as Array<{
        content: Array<{ type: string; text?: string }>;
      }>;
      const text = msg[0]?.content?.map((c) => c.text ?? "").join("") ?? "";
      const systemPrompt =
        (opts as { systemPrompt?: string }).systemPrompt ?? "";
      const ids = idsForMessage(text, systemPrompt);
      return {
        id: "msg_stub",
        role: "assistant",
        model: "stub-model",
        stopReason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "assign_leaves",
            input: { ids },
          },
        ],
      };
    },
  } as unknown as Provider;
}

let workspaceDir: string;
let dataDir: string;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "reconcile-ws-"));
  dataDir = await mkdtemp(join(tmpdir(), "reconcile-data-"));
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
  await rm(join(dataDir, "..", "v3-snapshots"), {
    recursive: true,
    force: true,
  }).catch(() => {});
});

/** Write a leaf `.md` with `{path, in_core, id}` frontmatter. */
async function writeLeaf(
  path: string,
  opts: { id?: string; inCore?: boolean; body?: string } = {},
): Promise<void> {
  const full = join(dataDir, "leaves", `${path}.md`);
  await mkdir(join(full, ".."), { recursive: true });
  const lines = [`path: ${path}`, `in_core: ${opts.inCore ?? false}`];
  if (opts.id) lines.push(`id: ${opts.id}`);
  await writeFile(
    full,
    `---\n${lines.join("\n")}\n---\n${opts.body ?? `Leaf ${path}.`}\n`,
  );
}

async function writeCore(alwaysOn: string[]): Promise<void> {
  await writeFile(join(dataDir, "core.json"), JSON.stringify({ alwaysOn }));
}

/**
 * `loadLeafTree` (used by the re-homing path) reads `assignments.json`
 * unconditionally, so seed an empty one. Page→leaf membership comes from page
 * frontmatter, not this file.
 */
async function seedAssignments(): Promise<void> {
  await writeFile(join(dataDir, "assignments.json"), "{}");
}

async function writePageWithLeaves(
  slug: string,
  leaves: string[],
): Promise<void> {
  await writePage(workspaceDir, {
    slug,
    frontmatter: { edges: [], ref_files: [], ref_urls: [], leaves },
    body: `Body of ${slug}.`,
  });
}

async function pageLeaves(slug: string): Promise<string[]> {
  const page = await readPage(workspaceDir, slug);
  return page?.frontmatter.leaves ?? [];
}

async function coreOf(): Promise<string[]> {
  const raw = await readFile(join(dataDir, "core.json"), "utf8");
  return (JSON.parse(raw) as { alwaysOn: string[] }).alwaysOn;
}

describe("reconcileTree", () => {
  test("rename preserves assignments (refs rewritten old → new)", async () => {
    // Current tree: the leaf moved from domain-a/topic-x → domain-b/topic-x,
    // keeping its stable id.
    await writeLeaf("domain-b/topic-x", { id: "leaf-x" });
    await writeCore(["domain-a/topic-x"]);
    await writePageWithLeaves("page-a", ["domain-a/topic-x"]);

    const prev: LeafRef[] = [{ id: "leaf-x", path: "domain-a/topic-x" }];
    const result = await reconcileTree({
      prevLeaves: prev,
      dataDir,
      workspaceDir,
    });

    expect(await pageLeaves("page-a")).toEqual(["domain-b/topic-x"]);
    expect(await coreOf()).toEqual(["domain-b/topic-x"]);
    expect(result.renames).toEqual([
      {
        id: "leaf-x",
        oldPath: "domain-a/topic-x",
        newPath: "domain-b/topic-x",
      },
    ]);
    expect(result.idToNewPath.get("leaf-x")).toBe("domain-b/topic-x");
  });

  test("delete re-homes members with no orphan", async () => {
    // leaf-x is deleted; leaf-y survives. page-a was only on leaf-x.
    await writeLeaf("domain-a/topic-y", { id: "leaf-y" });
    await writeCore([]);
    await seedAssignments();
    await writePageWithLeaves("page-a", ["domain-a/topic-x"]);

    // Surviving leaf is sorted index 1 (only leaf in tree).
    const provider = stubProvider(() => [1]);

    const prev: LeafRef[] = [
      { id: "leaf-x", path: "domain-a/topic-x" },
      { id: "leaf-y", path: "domain-a/topic-y" },
    ];
    const result = await reconcileTree({
      prevLeaves: prev,
      dataDir,
      workspaceDir,
      provider,
    });

    const after = await pageLeaves("page-a");
    // No orphan: at least one surviving leaf, and the dead path is gone.
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(after).not.toContain("domain-a/topic-x");
    expect(after).toContain("domain-a/topic-y");
    expect(result.deleted).toEqual(["domain-a/topic-x"]);
  });

  test("split distributes members across toPaths", async () => {
    // leaf-x splits into leaf-x1 (domain-a/x1) and leaf-x2 (domain-a/x2).
    await writeLeaf("domain-a/x1", { id: "leaf-x1" });
    await writeLeaf("domain-a/x2", { id: "leaf-x2" });
    // A third surviving leaf NOT in the split target set — members must not
    // land here.
    await writeLeaf("domain-b/other", { id: "leaf-other" });
    await writeCore([]);
    await seedAssignments();
    await writePageWithLeaves("page-a", ["domain-a/topic-x"]);
    await writePageWithLeaves("page-b", ["domain-a/topic-x"]);

    // Restricted tree (split.toPaths) sorts as [domain-a/x1, domain-a/x2].
    // page-a → x1 (id 1), page-b → x2 (id 2).
    const provider = stubProvider((message) =>
      message.includes("page-a") ? [1] : [2],
    );

    const prev: LeafRef[] = [{ id: "leaf-x", path: "domain-a/topic-x" }];
    await reconcileTree({
      prevLeaves: prev,
      dataDir,
      workspaceDir,
      provider,
      splits: [{ fromId: "leaf-x", toPaths: ["domain-a/x1", "domain-a/x2"] }],
    });

    expect(await pageLeaves("page-a")).toEqual(["domain-a/x1"]);
    expect(await pageLeaves("page-b")).toEqual(["domain-a/x2"]);
    // Neither page landed on the off-target leaf.
    expect(await pageLeaves("page-a")).not.toContain("domain-b/other");
    expect(await pageLeaves("page-b")).not.toContain("domain-b/other");
  });

  test("dangling core entry is pruned", async () => {
    await writeLeaf("domain-a/topic-x", { id: "leaf-x" });
    // core.json points at a leaf that no longer exists in the tree.
    await writeCore(["domain-a/topic-x", "domain-a/gone"]);
    await writePageWithLeaves("page-a", ["domain-a/topic-x"]);

    // No prev entry for the gone leaf and no page references it, so reconcile
    // succeeds and prunes the stale core entry.
    const prev: LeafRef[] = [{ id: "leaf-x", path: "domain-a/topic-x" }];
    const result = await reconcileTree({
      prevLeaves: prev,
      dataDir,
      workspaceDir,
    });

    expect(await coreOf()).toEqual(["domain-a/topic-x"]);
    expect(result.prunedCore).toEqual(["domain-a/gone"]);
  });

  test("residual dangling ref triggers validation throw + restore", async () => {
    // The current tree has only leaf-x. page-a references leaf-x (fine) PLUS a
    // residual leaf path that exists in NEITHER prev nor current — so it is
    // not a rename target and not a deleted-path drop, and survives the
    // rewrite as a dangling ref. Validation must fail closed and restore.
    await writeLeaf("domain-a/topic-x", { id: "leaf-x" });
    await writeCore(["domain-a/topic-x"]);
    await writePageWithLeaves("page-a", [
      "domain-a/topic-x",
      "domain-a/residual",
    ]);

    const prev: LeafRef[] = [{ id: "leaf-x", path: "domain-a/topic-x" }];

    await expect(
      reconcileTree({ prevLeaves: prev, dataDir, workspaceDir }),
    ).rejects.toThrow(/validation failed/);

    // Restored: page frontmatter reverted to its pre-reconcile state (both
    // refs, including the residual one) and core.json reverted.
    expect(await pageLeaves("page-a")).toEqual([
      "domain-a/topic-x",
      "domain-a/residual",
    ]);
    expect(await coreOf()).toEqual(["domain-a/topic-x"]);
  });
});
