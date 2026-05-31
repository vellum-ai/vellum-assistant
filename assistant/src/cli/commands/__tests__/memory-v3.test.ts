/**
 * Tests for the `memory v3` CLI command group's daemon-side handlers.
 *
 * The CLI subcommands are thin IPC shells over the handlers in
 * `runtime/routes/memory-v3-routes.ts`; the logic worth testing lives there.
 * We exercise the handlers directly against a temp workspace + data dir
 * injected via their `deps` parameter. Generic taxonomy only
 * (domain-a/topic-x, etc.).
 *
 * Source-of-truth note: `health` and `set-core` build the leaf tree from each
 * concept page's `leaves:` frontmatter (via the page index) and union it over
 * `assignments.json`, matching the consolidation-injected health block. The
 * fixture below writes concept pages with `leaves:` frontmatter as the
 * authoritative membership and keeps a *stale* `assignments.json` to prove the
 * handlers read the frontmatter, not the stale assignments. The seeded
 * skill/CLI-command catalogs are mocked empty so `allSlugs` (derived from the
 * page index) is deterministic.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as cliCommandStore from "../../../memory/v2/cli-command-store.js";
import { invalidatePageIndex } from "../../../memory/v2/page-index.js";
import * as skillStore from "../../../memory/v2/skill-store.js";
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

/** Write a concept page with `leaves:` frontmatter under memory/concepts/. */
async function writePage(slug: string, leaves: string[]): Promise<void> {
  const file = join(workspaceDir, "memory", "concepts", `${slug}.md`);
  await mkdir(join(file, ".."), { recursive: true });
  const fm = [
    "---",
    `summary: ${slug} summary`,
    "leaves:",
    ...leaves.map((l) => `  - ${l}`),
    "---",
    `${slug} body`,
    "",
  ].join("\n");
  await writeFile(file, fm);
}

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "mem-v3-cli-ws-"));
  dataDir = join(workspaceDir, "memory", "v3", "data");
  await mkdir(dataDir, { recursive: true });

  // Keep the page index deterministic regardless of the on-disk seeded
  // catalogs, and clear any module-cached index from a prior test.
  spyOn(skillStore, "listSkillEntries").mockReturnValue([]);
  spyOn(cliCommandStore, "listCliCommandEntries").mockReturnValue([]);
  invalidatePageIndex();

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

  // Authoritative membership lives in each page's `leaves:` frontmatter.
  await writePage("page-1", ["domain-a/topic-x"]);
  await writePage("page-2", ["domain-a/topic-x", "domain-a/topic-y"]);
  await writePage("page-3", ["domain-b/topic-z"]);

  // STALE assignments.json: deliberately divergent from the frontmatter above.
  // It re-maps the SAME slugs that already carry `leaves:` frontmatter to the
  // WRONG leaves. `loadLeafTree`'s per-page precedence only lets frontmatter win
  // when it is non-empty, so for these slugs the frontmatter wins and
  // assignments.json contributes no membership — proving the handlers read the
  // page index, not these stale assignments (the regression Defect A guards
  // against). We deliberately avoid a slug that exists ONLY in assignments.json:
  // such a slug has no frontmatter, falls back to its assignments entry, and
  // would inflate the cost preview below with phantom membership.
  await writeFile(
    join(dataDir, "assignments.json"),
    JSON.stringify({
      "page-1": ["domain-a/bogus-leaf"],
      "page-2": ["domain-b/topic-z"],
    }),
  );
  await writeFile(
    join(dataDir, "core.json"),
    JSON.stringify({ alwaysOn: ["domain-a/topic-x"] }),
  );
});

afterEach(async () => {
  invalidatePageIndex();
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

  test("previews the always-on page count from frontmatter membership", async () => {
    // Adding topic-y to core: core = {topic-x, topic-y}. Membership comes from
    // page `leaves:` frontmatter — topic-x → {page-1, page-2}, topic-y →
    // {page-2} ⇒ unique always-on slugs {page-1, page-2} = 2. If the handler
    // read the stale assignments.json instead (page-1 → bogus-leaf, page-2 →
    // topic-z), topic-x/topic-y would have no members and this would be 0.
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
  test("computes the slug universe from page frontmatter, not assignments.json", async () => {
    const result = await handleMemoryV3Health({ dataDir, workspaceDir });
    // domain-b/topic-z has a single member ⇒ a tiny leaf, so the report is
    // non-empty and renders the memory-v3 health header.
    expect(result.rendered).toContain("memory-v3 health:");
    expect(result.counts.tinyLeaves).toBeGreaterThanOrEqual(1);
    // Every page leaf ref (from frontmatter) resolves to a real leaf file ⇒ no
    // dangling refs. If assignments.json were the source, page-1's bogus-leaf
    // would dangle.
    expect(result.counts.danglingRefs).toBe(0);
    // The slug universe is the page-index pages (page-1..3), all assigned via
    // frontmatter, so nothing is unassigned.
    expect(result.counts.unassigned).toBe(0);
  });

  test("flags a page frontmatter ref with no backing leaf as dangling", async () => {
    await writePage("page-4", ["domain-a/missing-leaf"]);
    invalidatePageIndex();
    const result = await handleMemoryV3Health({ dataDir, workspaceDir });
    expect(result.counts.danglingRefs).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

describe("handleMemoryV3Reconcile", () => {
  test("no-op reconcile against an unchanged tree returns empty diffs", async () => {
    // v1: prevLeaves is derived from the current tree, so diffing
    // current-vs-current yields no renames/deletes — reconcile runs as a
    // convergence/prune pass. This still drives the full reconcileTree path
    // (snapshot → apply → validate → invalidate).
    const result = await handleMemoryV3Reconcile({ dataDir, workspaceDir });
    expect(result.renames).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.prunedCore).toEqual([]);
  });
});
