/**
 * Tests for the `memory v3` CLI command group's daemon-side handlers.
 *
 * The CLI subcommands are thin IPC shells over the handlers in
 * `runtime/routes/memory-v3-routes.ts`; the logic worth testing lives there.
 * We exercise the handlers directly against a temp workspace + data dir
 * injected via their `deps` parameter — no module mocking, no process-global
 * leaks. Generic taxonomy only (domain-a/topic-x, etc.).
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  handleMemoryV3Health,
  handleMemoryV3Reconcile,
  handleMemoryV3SetCore,
  UnknownLeafError,
} from "../../../runtime/routes/memory-v3-routes.js";

// ---------------------------------------------------------------------------
// Temp data-dir fixture
// ---------------------------------------------------------------------------

let workspaceDir: string;
let dataDir: string;

/** Write a leaf markdown file with the given frontmatter under leaves/. */
async function writeLeaf(
  relPath: string,
  frontmatter: { path: string; in_core: boolean; id?: string },
  body = "description",
): Promise<void> {
  const file = join(dataDir, "leaves", `${relPath}.md`);
  await mkdir(join(file, ".."), { recursive: true });
  const fm = [
    "---",
    `path: ${frontmatter.path}`,
    `in_core: ${frontmatter.in_core}`,
    ...(frontmatter.id ? [`id: ${frontmatter.id}`] : []),
    "---",
    body,
    "",
  ].join("\n");
  await writeFile(file, fm);
}

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "mem-v3-cli-ws-"));
  dataDir = join(workspaceDir, "memory", "v3", "data");
  await mkdir(dataDir, { recursive: true });
  // A small generic tree: two leaves under domain-a, one under domain-b.
  await writeLeaf("domain-a/topic-x", {
    path: "domain-a/topic-x",
    in_core: true,
    id: "leaf-x",
  });
  await writeLeaf("domain-a/topic-y", {
    path: "domain-a/topic-y",
    in_core: false,
    id: "leaf-y",
  });
  await writeLeaf("domain-b/topic-z", {
    path: "domain-b/topic-z",
    in_core: false,
    id: "leaf-z",
  });
  // assignments.json: page slugs → the leaves they belong to.
  await writeFile(
    join(dataDir, "assignments.json"),
    JSON.stringify({
      "page-1": ["domain-a/topic-x"],
      "page-2": ["domain-a/topic-x", "domain-a/topic-y"],
      "page-3": ["domain-b/topic-z"],
    }),
  );
  await writeFile(
    join(dataDir, "core.json"),
    JSON.stringify({ alwaysOn: ["domain-a/topic-x"] }),
  );
  // Empty concepts dir so the reconciler's listPages() returns [].
  await mkdir(join(workspaceDir, "memory", "concepts"), { recursive: true });
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// set-core
// ---------------------------------------------------------------------------

describe("handleMemoryV3SetCore", () => {
  test("rejects an unknown leaf and does not write", async () => {
    const call = handleMemoryV3SetCore(
      { add: ["domain-a/does-not-exist"], write: true },
      { dataDir, workspaceDir },
    );
    await expect(call).rejects.toThrow(/domain-a\/does-not-exist/);
    await expect(
      handleMemoryV3SetCore(
        { add: ["domain-a/does-not-exist"], write: true },
        { dataDir, workspaceDir },
      ),
    ).rejects.toBeInstanceOf(UnknownLeafError);

    // core.json must be untouched (still just the original entry).
    const core = JSON.parse(await readFile(join(dataDir, "core.json"), "utf8"));
    expect(core.alwaysOn).toEqual(["domain-a/topic-x"]);
  });

  test("previews the always-on page count without writing", async () => {
    // Adding topic-y to core: core = {topic-x, topic-y}. Unique member slugs:
    // topic-x → {page-1, page-2}, topic-y → {page-2} ⇒ {page-1, page-2} = 2.
    const result = await handleMemoryV3SetCore(
      { add: ["domain-a/topic-y"] },
      { dataDir, workspaceDir },
    );
    expect(result.written).toBe(false);
    expect(result.nextCore).toEqual(["domain-a/topic-x", "domain-a/topic-y"]);
    expect(result.alwaysOnPageCount).toBe(2);

    // No write happened — core.json still holds only the original entry.
    const core = JSON.parse(await readFile(join(dataDir, "core.json"), "utf8"));
    expect(core.alwaysOn).toEqual(["domain-a/topic-x"]);
  });

  test("writes core.json on --yes (write: true)", async () => {
    const result = await handleMemoryV3SetCore(
      { add: ["domain-b/topic-z"], write: true },
      { dataDir, workspaceDir },
    );
    expect(result.written).toBe(true);
    expect(result.nextCore).toEqual(["domain-a/topic-x", "domain-b/topic-z"]);

    const core = JSON.parse(await readFile(join(dataDir, "core.json"), "utf8"));
    expect(core.alwaysOn).toEqual(["domain-a/topic-x", "domain-b/topic-z"]);
  });

  test("remove is idempotent for an absent entry", async () => {
    const result = await handleMemoryV3SetCore(
      { remove: ["domain-a/topic-y"], write: true },
      { dataDir, workspaceDir },
    );
    // topic-y was never in core; result is the original core unchanged.
    expect(result.nextCore).toEqual(["domain-a/topic-x"]);
  });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

describe("handleMemoryV3Health", () => {
  test("renders a report and counts for the temp tree", async () => {
    const result = await handleMemoryV3Health({ dataDir, workspaceDir });
    // domain-b/topic-z has a single member ⇒ a tiny leaf, so the report is
    // non-empty and renders the memory-v3 health header.
    expect(result.rendered).toContain("memory-v3 health:");
    expect(result.counts.tinyLeaves).toBeGreaterThanOrEqual(1);
    expect(result.counts.danglingRefs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

describe("handleMemoryV3Reconcile", () => {
  test("no-op reconcile against an unchanged tree returns empty diffs", async () => {
    // prevLeaves is derived from the current tree, so diffing current-vs-current
    // yields no renames/deletes. This still drives the full reconcileTree path
    // (snapshot → apply → validate → invalidate).
    const result = await handleMemoryV3Reconcile({ dataDir, workspaceDir });
    expect(result.renames).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.prunedCore).toEqual([]);

    // A snapshot directory was created as a side effect.
    const snapshotsRoot = join(workspaceDir, "memory", "v3", "v3-snapshots");
    const entries = await readdir(snapshotsRoot);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});
