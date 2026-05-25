/**
 * Tests for `assistant/src/memory/v3/tree-store.ts`.
 *
 * Coverage matrix:
 *   - slugify: lowercase / kebab-case / ascii / 80-char cap / empty fallback.
 *   - validateNodeId: accept set, reject set (path-traversal, malformed shapes),
 *     reserved `_root` accepted.
 *   - readNode / writeNode round-trip: frontmatter survives, body preserved.
 *   - children refs parse for both `page:` and `node:` forms.
 *   - malformed YAML / unknown frontmatter keys throw.
 *   - readNode on missing file: returns null.
 *   - writeNode atomicity: no orphan tmp on success, parent dirs created.
 *   - listNodes: walks subdirectories, returns nested ids in `/`-form, excludes
 *     hidden dirs / non-.md / temp files, missing dir → [].
 *   - deleteNode: nested-id round-trip, idempotent on missing.
 *   - renderNodeContent: frontmatter + body shape.
 *   - No change to memory/concepts/ (v3 lives under memory/v3/tree/).
 *
 * Tests use temp workspaces under `os.tmpdir()`; they never touch `~/.vellum/`.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  deleteNode,
  getTreeDir,
  listNodes,
  readNode,
  renderNodeContent,
  ROOT_NODE_ID,
  slugify,
  validateNodeId,
  writeNode,
} from "../tree-store.js";
import type { TreeNode } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-tree-store-test-"));
  // Mirror the workspace migration so readNode / writeNode have a target dir.
  mkdirSync(getTreeDir(workspaceDir), { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function makeNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: "people",
    frontmatter: {
      children: ["page:people/alice", "node:people/colleagues"],
      routing_hints: "for work relationships see people/colleagues",
      summary: "People I know.",
    },
    body: "The people branch of the memory tree.\n",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  test("lowercases ASCII letters", () => {
    expect(slugify("AliceBob")).toBe("alicebob");
  });

  test("converts spaces and punctuation to single hyphens", () => {
    expect(slugify("Alice's Preferred IDE!")).toBe("alice-s-preferred-ide");
  });

  test("collapses runs of separators to one hyphen", () => {
    expect(slugify("foo   ___ bar")).toBe("foo-bar");
  });

  test("trims leading and trailing hyphens", () => {
    expect(slugify("---hello world---")).toBe("hello-world");
  });

  test("collapses '/' to hyphen — slugify produces a single segment", () => {
    expect(slugify("People/Colleagues")).toBe("people-colleagues");
  });

  test("caps slug length at 80 chars and re-trims trailing hyphen", () => {
    const long = "a".repeat(120);
    const slug = slugify(long);
    expect(slug.length).toBe(80);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("falls back to a unique placeholder for empty inputs", () => {
    const a = slugify("");
    const b = slugify("!!!");
    expect(a).toMatch(/^node-[a-f0-9]{8}$/);
    expect(b).toMatch(/^node-[a-f0-9]{8}$/);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// validateNodeId
// ---------------------------------------------------------------------------

describe("validateNodeId", () => {
  test.each([
    ["people"],
    ["a"],
    ["people-colleagues"],
    ["people/alice"],
    ["people/colleagues/alice"],
    ["a/b/c/d/e"],
    [ROOT_NODE_ID],
  ])("accepts %p", (id) => {
    expect(() => validateNodeId(id)).not.toThrow();
  });

  test.each([
    ["empty string", ""],
    ["leading slash", "/people"],
    ["trailing slash", "people/"],
    ["double slash", "people//alice"],
    ["dot-dot segment", "people/../alice"],
    ["pure dot-dot", ".."],
    ["leading dot segment", ".hidden/alice"],
    ["backslash", "people\\alice"],
    ["null byte", "people\0evil"],
    ["whitespace", "people alice"],
    ["uppercase", "People"],
    ["non-ascii", "café"],
    ["leading hyphen", "-people"],
    ["non-alphanumeric", "people!"],
    ["leading underscore (only _root reserved)", "_other"],
  ])("rejects %s (%p)", (_label, id) => {
    expect(() => validateNodeId(id)).toThrow(/Invalid tree-node id/);
  });

  test("rejects ids longer than 200 chars", () => {
    expect(() => validateNodeId("a".repeat(201))).toThrow(
      /Invalid tree-node id/,
    );
  });

  test("rejects segments longer than 80 chars even if total is under 200", () => {
    expect(() => validateNodeId("a".repeat(81))).toThrow(
      /Invalid tree-node id/,
    );
  });
});

// ---------------------------------------------------------------------------
// readNode / writeNode round-trip
// ---------------------------------------------------------------------------

describe("writeNode + readNode round-trip", () => {
  test("round-trips frontmatter and body verbatim", async () => {
    const node = makeNode();
    await writeNode(workspaceDir, node);

    const read = await readNode(workspaceDir, node.id);
    expect(read).not.toBeNull();
    expect(read!.id).toBe(node.id);
    expect(read!.frontmatter.children).toEqual(node.frontmatter.children);
    expect(read!.frontmatter.routing_hints).toBe(
      node.frontmatter.routing_hints,
    );
    expect(read!.frontmatter.summary).toBe(node.frontmatter.summary);
    expect(read!.body).toBe(node.body);
  });

  test("children parse for both page: and node: reference forms", async () => {
    const node = makeNode({
      id: "mixed",
      frontmatter: {
        children: ["page:procs/git-flow", "node:procs", "page:alice"],
      },
      body: "mixed refs\n",
    });
    await writeNode(workspaceDir, node);

    const read = await readNode(workspaceDir, "mixed");
    expect(read!.frontmatter.children).toEqual([
      "page:procs/git-flow",
      "node:procs",
      "page:alice",
    ]);
  });

  test("the children list IS the DAG edge — a page may be referenced by multiple parents", async () => {
    await writeNode(
      workspaceDir,
      makeNode({
        id: "team-a",
        frontmatter: { children: ["page:people/alice"] },
        body: "team a\n",
      }),
    );
    await writeNode(
      workspaceDir,
      makeNode({
        id: "team-b",
        frontmatter: { children: ["page:people/alice"] },
        body: "team b\n",
      }),
    );

    const a = await readNode(workspaceDir, "team-a");
    const b = await readNode(workspaceDir, "team-b");
    expect(a!.frontmatter.children).toContain("page:people/alice");
    expect(b!.frontmatter.children).toContain("page:people/alice");
  });

  test("renders frontmatter at the top with --- delimiters", async () => {
    const node = makeNode();
    await writeNode(workspaceDir, node);

    const raw = readFileSync(
      join(getTreeDir(workspaceDir), `${node.id}.md`),
      "utf-8",
    );
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw.split("---").length).toBeGreaterThanOrEqual(3);
    expect(raw).toContain("The people branch");
  });

  test("preserves an empty body", async () => {
    const node = makeNode({ body: "" });
    await writeNode(workspaceDir, node);

    const read = await readNode(workspaceDir, node.id);
    expect(read!.body).toBe("");
  });

  test("preserves multiline body with embedded YAML-looking lines", async () => {
    const tricky = "key: value\n---\nnot-frontmatter\n";
    const node = makeNode({ id: "tricky", body: tricky });
    await writeNode(workspaceDir, node);

    const read = await readNode(workspaceDir, node.id);
    expect(read!.body).toBe(tricky);
  });

  test("defaults children to [] for a node with empty frontmatter", async () => {
    const node = makeNode({
      id: "bare",
      frontmatter: { children: [] },
      body: "bare\n",
    });
    await writeNode(workspaceDir, node);

    const read = await readNode(workspaceDir, "bare");
    expect(read!.frontmatter.children).toEqual([]);
    expect(read!.frontmatter.routing_hints).toBeUndefined();
    expect(read!.frontmatter.summary).toBeUndefined();
  });

  test("readNode returns null for an id that does not exist", async () => {
    const result = await readNode(workspaceDir, "nonexistent");
    expect(result).toBeNull();
  });

  test("readNode parses a hand-written node with no frontmatter as empty frontmatter + full body", async () => {
    const id = "no-frontmatter";
    const body = "Just some prose, no YAML.\n";
    writeFileSync(join(getTreeDir(workspaceDir), `${id}.md`), body, "utf-8");

    const read = await readNode(workspaceDir, id);
    expect(read).not.toBeNull();
    expect(read!.frontmatter.children).toEqual([]);
    expect(read!.body).toBe(body);
  });

  test("readNode throws on malformed YAML frontmatter", async () => {
    const id = "bad-yaml";
    // Unclosed bracket inside the frontmatter block — invalid YAML.
    const raw = "---\nchildren: [unterminated\n---\nbody\n";
    writeFileSync(join(getTreeDir(workspaceDir), `${id}.md`), raw, "utf-8");

    await expect(readNode(workspaceDir, id)).rejects.toThrow();
  });

  test("readNode throws on unknown frontmatter keys instead of silently dropping them", async () => {
    const id = "extra-keys";
    const raw = "---\nchildren: []\nunknown_field: oops\n---\nbody\n";
    writeFileSync(join(getTreeDir(workspaceDir), `${id}.md`), raw, "utf-8");

    await expect(readNode(workspaceDir, id)).rejects.toThrow();
  });

  test("writeNode overwrites an existing node", async () => {
    await writeNode(workspaceDir, makeNode({ body: "first\n" }));
    await writeNode(workspaceDir, makeNode({ body: "second\n" }));

    const read = await readNode(workspaceDir, "people");
    expect(read!.body).toBe("second\n");
  });

  test("writeNode creates parent directories for nested ids", async () => {
    const node = makeNode({ id: "people/colleagues" });
    await writeNode(workspaceDir, node);

    const filePath = join(getTreeDir(workspaceDir), "people", "colleagues.md");
    expect(existsSync(filePath)).toBe(true);

    const read = await readNode(workspaceDir, "people/colleagues");
    expect(read!.id).toBe("people/colleagues");
    expect(read!.body).toBe(node.body);
  });

  test("writeNode round-trips deeply nested ids", async () => {
    const node = makeNode({ id: "people/colleagues/alice" });
    await writeNode(workspaceDir, node);

    const read = await readNode(workspaceDir, "people/colleagues/alice");
    expect(read!.id).toBe("people/colleagues/alice");
    expect(read!.frontmatter.children).toEqual(node.frontmatter.children);
    expect(read!.body).toBe(node.body);
  });

  test("writeNode + readNode round-trip the reserved _root id", async () => {
    const node = makeNode({
      id: ROOT_NODE_ID,
      frontmatter: { children: ["node:people"] },
      body: "root of the tree\n",
    });
    await writeNode(workspaceDir, node);

    const read = await readNode(workspaceDir, ROOT_NODE_ID);
    expect(read!.id).toBe(ROOT_NODE_ID);
    expect(read!.frontmatter.children).toEqual(["node:people"]);
  });

  test("writeNode rejects malicious ids and writes nothing at the escape target", async () => {
    await expect(
      writeNode(workspaceDir, makeNode({ id: "../escape" })),
    ).rejects.toThrow(/Invalid tree-node id/);

    // `../escape` would resolve to `<workspace>/memory/v3/escape.md`. Confirm
    // the validation throw fired before any I/O — no file at that target.
    expect(existsSync(join(workspaceDir, "memory", "v3", "escape.md"))).toBe(
      false,
    );
  });

  test("readNode rejects malicious ids", async () => {
    await expect(readNode(workspaceDir, "../escape")).rejects.toThrow(
      /Invalid tree-node id/,
    );
  });

  test("successful write produces no orphan tmp files", async () => {
    await writeNode(workspaceDir, makeNode());

    const remaining = readdirSync(getTreeDir(workspaceDir));
    const orphanTmps = remaining.filter((name) => name.includes(".tmp."));
    expect(orphanTmps).toEqual([]);
  });

  test("does not touch memory/concepts/", async () => {
    await writeNode(workspaceDir, makeNode({ id: "people/colleagues" }));

    expect(existsSync(join(workspaceDir, "memory", "concepts"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderNodeContent
// ---------------------------------------------------------------------------

describe("renderNodeContent", () => {
  test("emits frontmatter block followed by body", () => {
    const rendered = renderNodeContent(makeNode());
    expect(rendered.startsWith("---\n")).toBe(true);
    expect(rendered).toContain("children:");
    expect(rendered).toContain("page:people/alice");
    expect(rendered.endsWith("The people branch of the memory tree.\n")).toBe(
      true,
    );
  });

  test("keeps the explicit children key even when empty", () => {
    const rendered = renderNodeContent(
      makeNode({ frontmatter: { children: [] }, body: "x\n" }),
    );
    expect(rendered).toContain("children: []");
  });
});

// ---------------------------------------------------------------------------
// listNodes
// ---------------------------------------------------------------------------

describe("listNodes", () => {
  test("returns ids (filename minus .md) for every node on disk", async () => {
    await writeNode(workspaceDir, makeNode({ id: "alice" }));
    await writeNode(workspaceDir, makeNode({ id: "bob" }));
    await writeNode(workspaceDir, makeNode({ id: "carol" }));

    const ids = await listNodes(workspaceDir);
    expect(ids).toEqual(["alice", "bob", "carol"]);
  });

  test("excludes non-.md files in the tree directory", async () => {
    await writeNode(workspaceDir, makeNode({ id: "alice" }));

    const treeDir = getTreeDir(workspaceDir);
    writeFileSync(join(treeDir, "README.txt"), "ignore me", "utf-8");
    writeFileSync(join(treeDir, "image.png"), "fake", "utf-8");
    writeFileSync(join(treeDir, ".hidden"), "fake", "utf-8");

    const ids = await listNodes(workspaceDir);
    expect(ids).toEqual(["alice"]);
  });

  test("walks subdirectories and returns nested ids in '/'-form", async () => {
    await writeNode(workspaceDir, makeNode({ id: "alice" }));
    await writeNode(workspaceDir, makeNode({ id: "people/bob" }));
    await writeNode(workspaceDir, makeNode({ id: "people/carol" }));
    await writeNode(workspaceDir, makeNode({ id: "arcs/2025-04/cutover" }));

    const ids = await listNodes(workspaceDir);
    expect(ids).toEqual([
      "alice",
      "arcs/2025-04/cutover",
      "people/bob",
      "people/carol",
    ]);
  });

  test("skips hidden subdirectories and non-.md files inside nested dirs", async () => {
    await writeNode(workspaceDir, makeNode({ id: "people/alice" }));

    const treeDir = getTreeDir(workspaceDir);
    mkdirSync(join(treeDir, ".git"), { recursive: true });
    writeFileSync(join(treeDir, ".git", "config.md"), "fake", "utf-8");
    writeFileSync(join(treeDir, "people", "notes.txt"), "ignore", "utf-8");

    const ids = await listNodes(workspaceDir);
    expect(ids).toEqual(["people/alice"]);
  });

  test("skips orphaned .tmp.* files at any depth", async () => {
    const treeDir = getTreeDir(workspaceDir);
    await writeNode(workspaceDir, makeNode({ id: "people/alice" }));

    writeFileSync(
      join(treeDir, "alice.md.tmp.123.abc-def"),
      "stranded",
      "utf-8",
    );
    writeFileSync(
      join(treeDir, "people", "bob.md.tmp.123.abc-def"),
      "stranded",
      "utf-8",
    );

    const ids = await listNodes(workspaceDir);
    expect(ids).toEqual(["people/alice"]);
  });

  test("returns [] when the tree directory does not exist", async () => {
    rmSync(getTreeDir(workspaceDir), { recursive: true, force: true });

    const ids = await listNodes(workspaceDir);
    expect(ids).toEqual([]);
  });

  test("returns [] when the tree directory is empty", async () => {
    const ids = await listNodes(workspaceDir);
    expect(ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deleteNode
// ---------------------------------------------------------------------------

describe("deleteNode", () => {
  test("removes the node from disk", async () => {
    const node = makeNode();
    await writeNode(workspaceDir, node);
    expect(await readNode(workspaceDir, node.id)).not.toBeNull();

    await deleteNode(workspaceDir, node.id);
    expect(await readNode(workspaceDir, node.id)).toBeNull();
  });

  test("removes nested nodes", async () => {
    const node = makeNode({ id: "people/colleagues" });
    await writeNode(workspaceDir, node);

    await deleteNode(workspaceDir, "people/colleagues");
    expect(await readNode(workspaceDir, "people/colleagues")).toBeNull();
  });

  test("is idempotent — deleting a missing node does not throw", async () => {
    await deleteNode(workspaceDir, "never-existed");
    await deleteNode(workspaceDir, "never-existed");
  });

  test("does not affect other nodes", async () => {
    await writeNode(workspaceDir, makeNode({ id: "alice" }));
    await writeNode(workspaceDir, makeNode({ id: "bob" }));

    await deleteNode(workspaceDir, "alice");

    expect(await readNode(workspaceDir, "alice")).toBeNull();
    expect(await readNode(workspaceDir, "bob")).not.toBeNull();
  });
});
