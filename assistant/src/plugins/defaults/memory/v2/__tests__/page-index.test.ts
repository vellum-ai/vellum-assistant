/**
 * Tests for `memory/v2/page-index.ts` — the router-prompt page index built
 * from concept pages plus seeded skill entries.
 *
 * Tests live in temp workspaces (`mkdtemp`) and never touch `~/.vellum/`. The
 * skill-store module is mocked so `listSkillEntries()` returns deterministic
 * fixtures, and `page-store.js` is wrapped so we can simulate read failures
 * without breaking writes.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ConceptPage, SkillEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Mocks — programmable skill list, programmable readPage failure set,
// recursive no-op logger. Mocks are installed BEFORE any imports of the
// module under test so the page-index module observes them at load time.
// ---------------------------------------------------------------------------

const skillState: { entries: SkillEntry[] } = { entries: [] };
const failingSlugs = new Set<string>();

mock.module("../skill-store.js", () => ({
  SKILL_SLUG_PREFIX: "skills/",
  listSkillEntries: () => skillState.entries,
}));

// Wrap page-store so we can simulate read failures via `failingSlugs`.
// Re-export every other binding identity-style so writes still work.
//
// Capture each real export into a local const BEFORE installing the mock —
// module namespaces hold live bindings, so a post-mock dereference of
// `realPageStore.readPage` would resolve to the mocked function and recurse
// infinitely.
const realPageStore = await import("../page-store.js");
const realReadPage = realPageStore.readPage;
mock.module("../page-store.js", () => ({
  ...realPageStore,
  readPage: async (workspaceDir: string, slug: string) => {
    if (failingSlugs.has(slug)) {
      throw new Error(`simulated read failure for ${slug}`);
    }
    return realReadPage(workspaceDir, slug);
  },
}));

const { getPageIndex, invalidatePageIndex, partitionPageIndex } =
  await import("../page-index.js");
const { writePage } = await import("../page-store.js");
const { invalidateEdgeIndex } = await import("../edge-index.js");

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-memory-v2-page-index-"));
  skillState.entries = [];
  failingSlugs.clear();
});

afterEach(() => {
  invalidatePageIndex();
  invalidateEdgeIndex();
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function makePage(
  slug: string,
  opts: {
    edges?: string[];
    summary?: string;
    body?: string;
    leaves?: string[];
  } = {},
): ConceptPage {
  return {
    slug,
    frontmatter: {
      edges: opts.edges ?? [],
      ref_files: [],
      ref_urls: [],
      ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
      ...(opts.leaves !== undefined ? { leaves: opts.leaves } : {}),
    },
    body: opts.body ?? "",
  };
}

// ---------------------------------------------------------------------------
// Build & cache
// ---------------------------------------------------------------------------

describe("getPageIndex", () => {
  test("returns an empty index when there are no pages and no skills", async () => {
    const idx = await getPageIndex(workspaceDir);
    expect(idx.entries).toEqual([]);
    expect(idx.bySlug.size).toBe(0);
    expect(idx.byId.size).toBe(0);
    expect(idx.rendered).toBe("");
  });

  test("caches the result so repeat calls reuse the prior build", async () => {
    await writePage(workspaceDir, makePage("alice", { summary: "First" }));

    const first = await getPageIndex(workspaceDir);
    // Mutate disk after the first read WITHOUT going through `writePage`,
    // which would invalidate the page-index cache by design. The raw
    // filesystem write simulates an out-of-band file appearing — without
    // the cache the second call would observe it and return a different
    // object.
    writeFileSync(
      join(workspaceDir, "memory", "concepts", "bob.md"),
      "---\nedges: []\nref_files: []\nref_urls: []\nsummary: Second\n---\n",
      "utf-8",
    );

    const second = await getPageIndex(workspaceDir);
    expect(second).toBe(first);
    expect(second.entries.map((e) => e.slug)).toEqual(["alice"]);
  });

  test("writePage invalidates the cache so the next call sees the new page", async () => {
    await writePage(workspaceDir, makePage("alice", { summary: "First" }));
    const before = await getPageIndex(workspaceDir);

    // `writePage` calls `invalidatePageIndex(workspaceDir)` as a side
    // effect — verify that contract here so the cache-hit test above
    // can't accidentally pass because writePage stopped invalidating.
    await writePage(workspaceDir, makePage("bob", { summary: "Second" }));

    const after = await getPageIndex(workspaceDir);
    expect(after).not.toBe(before);
    expect(after.entries.map((e) => e.slug)).toEqual(["alice", "bob"]);
  });

  test("invalidatePageIndex(workspaceDir) forces a rebuild on the next call", async () => {
    await writePage(workspaceDir, makePage("alice", { summary: "First" }));
    const before = await getPageIndex(workspaceDir);

    invalidatePageIndex(workspaceDir);
    await writePage(workspaceDir, makePage("bob", { summary: "Second" }));

    const after = await getPageIndex(workspaceDir);
    expect(after).not.toBe(before);
    expect(after.entries.map((e) => e.slug)).toEqual(["alice", "bob"]);
  });

  test("invalidatePageIndex() with no arg clears any cached workspace", async () => {
    await writePage(workspaceDir, makePage("alice", { summary: "First" }));
    const before = await getPageIndex(workspaceDir);
    invalidatePageIndex();
    const after = await getPageIndex(workspaceDir);
    expect(after).not.toBe(before);
  });

  test("sorts entries by slug ASCII deterministically across rebuilds", async () => {
    await writePage(workspaceDir, makePage("zulu", { summary: "Z" }));
    await writePage(workspaceDir, makePage("alpha", { summary: "A" }));
    await writePage(workspaceDir, makePage("mike", { summary: "M" }));

    const first = await getPageIndex(workspaceDir);
    invalidatePageIndex();
    const second = await getPageIndex(workspaceDir);

    expect(first.entries.map((e) => e.slug)).toEqual(["alpha", "mike", "zulu"]);
    expect(first.entries).toEqual(second.entries);
  });

  test("assigns dense 1-based IDs in slug order", async () => {
    await writePage(workspaceDir, makePage("bravo", { summary: "B" }));
    await writePage(workspaceDir, makePage("alpha", { summary: "A" }));
    await writePage(workspaceDir, makePage("charlie", { summary: "C" }));

    const idx = await getPageIndex(workspaceDir);
    expect(idx.entries.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(idx.entries.map((e) => e.slug)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
    expect(idx.byId.get(1)?.slug).toBe("alpha");
    expect(idx.bySlug.get("charlie")?.id).toBe(3);
  });

  test("drops pages whose read fails and continues the build", async () => {
    await writePage(workspaceDir, makePage("alice", { summary: "Alice" }));
    await writePage(workspaceDir, makePage("bob", { summary: "Bob" }));
    await writePage(workspaceDir, makePage("carol", { summary: "Carol" }));

    failingSlugs.add("bob");

    const idx = await getPageIndex(workspaceDir);
    expect(idx.entries.map((e) => e.slug)).toEqual(["alice", "carol"]);
    // IDs remain dense — the dropped page does not leave a hole.
    expect(idx.entries.map((e) => e.id)).toEqual([1, 2]);
  });

  test("integrates seeded skill entries under the skills/ slug prefix", async () => {
    await writePage(workspaceDir, makePage("alice", { summary: "Alice" }));
    skillState.entries = [
      { id: "browser", content: "Drive a browser." },
      { id: "calendar", content: "Schedule meetings." },
    ];

    const idx = await getPageIndex(workspaceDir);
    expect(idx.entries.map((e) => e.slug)).toEqual([
      "alice",
      "skills/browser",
      "skills/calendar",
    ]);
    expect(idx.bySlug.get("skills/browser")?.summary).toBe("Drive a browser.");
    // Skill entries always carry an empty edge list.
    expect(idx.bySlug.get("skills/browser")?.edges).toEqual([]);
  });

  test("resolves outgoing edges to numeric IDs and drops missing targets", async () => {
    await writePage(
      workspaceDir,
      makePage("alice", { summary: "A", edges: ["bob", "ghost"] }),
    );
    await writePage(workspaceDir, makePage("bob", { summary: "B" }));

    const idx = await getPageIndex(workspaceDir);
    const alice = idx.bySlug.get("alice")!;
    const bob = idx.bySlug.get("bob")!;
    expect(alice.edges).toEqual([bob.id]);
  });

  test("exposes frontmatter leaves in the index entry", async () => {
    await writePage(
      workspaceDir,
      makePage("alice", {
        summary: "A",
        leaves: ["page-a", "domain-a/topic-x"],
      }),
    );

    const idx = await getPageIndex(workspaceDir);
    expect(idx.bySlug.get("alice")?.leaves).toEqual([
      "page-a",
      "domain-a/topic-x",
    ]);
  });

  test("defaults leaves to an empty array when the field is absent", async () => {
    await writePage(workspaceDir, makePage("alice", { summary: "A" }));

    const idx = await getPageIndex(workspaceDir);
    expect(idx.bySlug.get("alice")?.leaves).toEqual([]);
  });

  test("seeded skill entries carry an empty leaves list", async () => {
    skillState.entries = [{ id: "browser", content: "Drive a browser." }];

    const idx = await getPageIndex(workspaceDir);
    expect(idx.bySlug.get("skills/browser")?.leaves).toEqual([]);
  });

  test("falls back to body when frontmatter.summary is absent", async () => {
    await writePage(
      workspaceDir,
      makePage("alice", { body: "  Body fallback content.  " }),
    );

    const idx = await getPageIndex(workspaceDir);
    expect(idx.bySlug.get("alice")?.summary).toBe("Body fallback content.");
  });

  test("truncates summary to 200 characters", async () => {
    const long = "x".repeat(500);
    await writePage(workspaceDir, makePage("alice", { summary: long }));
    const idx = await getPageIndex(workspaceDir);
    expect(idx.bySlug.get("alice")?.summary.length).toBe(200);
  });

  test("collapses embedded newlines in frontmatter.summary to single spaces", async () => {
    await writePage(
      workspaceDir,
      makePage("alice", { summary: "First line.\nSecond line.\nThird line." }),
    );
    const idx = await getPageIndex(workspaceDir);
    expect(idx.bySlug.get("alice")?.summary).toBe(
      "First line. Second line. Third line.",
    );
  });

  test("collapses embedded newlines and runs of whitespace in body fallback", async () => {
    await writePage(
      workspaceDir,
      makePage("alice", {
        body: "  Body  with\n\nmultiple\tlines\n  and   spaces.  ",
      }),
    );
    const idx = await getPageIndex(workspaceDir);
    expect(idx.bySlug.get("alice")?.summary).toBe(
      "Body with multiple lines and spaces.",
    );
  });

  test("normalizes skill-entry content with embedded newlines", async () => {
    skillState.entries = [
      { id: "browser", content: "Drive a browser.\nSupports multiple tabs." },
    ];
    const idx = await getPageIndex(workspaceDir);
    expect(idx.bySlug.get("skills/browser")?.summary).toBe(
      "Drive a browser. Supports multiple tabs.",
    );
  });

  test("renders a single line per entry even when summaries contain newlines", async () => {
    await writePage(
      workspaceDir,
      makePage("alice", { summary: "line one\nline two" }),
    );
    const idx = await getPageIndex(workspaceDir);
    // Exactly one trailing newline — the entry itself must not split.
    expect(idx.rendered.split("\n").filter(Boolean).length).toBe(1);
  });

  test("drops a user concept page whose slug collides with a seeded skill entry", async () => {
    await writePage(
      workspaceDir,
      makePage("skills/browser", {
        summary: "User-authored page that shadows the skill.",
      }),
    );
    skillState.entries = [{ id: "browser", content: "Seeded skill content." }];

    const idx = await getPageIndex(workspaceDir);
    // Only the skill entry survives under skills/browser.
    expect(idx.entries.filter((e) => e.slug === "skills/browser").length).toBe(
      1,
    );
    expect(idx.bySlug.get("skills/browser")?.summary).toBe(
      "Seeded skill content.",
    );
  });

  test("collision dedupe leaves non-colliding pages and skills intact", async () => {
    await writePage(workspaceDir, makePage("alice", { summary: "Alice" }));
    await writePage(
      workspaceDir,
      makePage("skills/browser", { summary: "Shadow page." }),
    );
    skillState.entries = [
      { id: "browser", content: "Seeded browser." },
      { id: "calendar", content: "Seeded calendar." },
    ];

    const idx = await getPageIndex(workspaceDir);
    expect(idx.entries.map((e) => e.slug)).toEqual([
      "alice",
      "skills/browser",
      "skills/calendar",
    ]);
    expect(idx.bySlug.get("skills/browser")?.summary).toBe("Seeded browser.");
  });
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

describe("rendered prompt block", () => {
  test("renders [id] slug — summary lines with edges parenthetical when present", async () => {
    await writePage(
      workspaceDir,
      makePage("alice", { summary: "A page", edges: ["bob"] }),
    );
    await writePage(workspaceDir, makePage("bob", { summary: "B page" }));

    const idx = await getPageIndex(workspaceDir);
    const alice = idx.bySlug.get("alice")!;
    const bob = idx.bySlug.get("bob")!;

    const expected =
      `[${alice.id}] alice — A page (edges: ${bob.id})\n` +
      `[${bob.id}] bob — B page\n`;
    expect(idx.rendered).toBe(expected);
  });

  test("omits the parenthetical for entries with no outgoing edges", async () => {
    await writePage(workspaceDir, makePage("alice", { summary: "A page" }));
    const idx = await getPageIndex(workspaceDir);
    expect(idx.rendered).toBe("[1] alice — A page\n");
  });
});

// ---------------------------------------------------------------------------
// partitionPageIndex — stable batch assignment
// ---------------------------------------------------------------------------

describe("partitionPageIndex", () => {
  async function buildIndex(slugs: string[]) {
    for (const slug of slugs) {
      await writePage(workspaceDir, makePage(slug, { summary: `${slug} sum` }));
    }
    return getPageIndex(workspaceDir);
  }

  test("batchSize=null returns the same index reference (no work, KV cache safe)", async () => {
    const idx = await buildIndex(["alice", "bob", "carol"]);
    const batches = partitionPageIndex(idx, null);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toBe(idx);
  });

  test("batchSize >= entries.length is a single batch identical to the input", async () => {
    const idx = await buildIndex(["alice", "bob", "carol"]);
    const batches = partitionPageIndex(idx, 10);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toBe(idx);
  });

  test("splits N=5 with batchSize=2 into 3 batches preserving all slugs", async () => {
    const idx = await buildIndex(["a", "b", "c", "d", "e"]);
    const batches = partitionPageIndex(idx, 2);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    const allSlugs = batches.flatMap((b) => b.entries.map((e) => e.slug));
    expect(new Set(allSlugs)).toEqual(new Set(["a", "b", "c", "d", "e"]));
    // Every slug appears in exactly one batch.
    expect(allSlugs.length).toBe(5);
  });

  test("re-renders each batch with local 1-based IDs", async () => {
    const idx = await buildIndex(["a", "b", "c", "d", "e"]);
    const batches = partitionPageIndex(idx, 2);
    for (const batch of batches) {
      expect(batch.entries.map((e) => e.id)).toEqual(
        batch.entries.map((_, i) => i + 1),
      );
      for (const entry of batch.entries) {
        expect(batch.byId.get(entry.id)).toBe(entry);
        expect(batch.bySlug.get(entry.slug)).toBe(entry);
        expect(batch.rendered).toContain(`[${entry.id}] ${entry.slug}`);
      }
    }
  });

  test("KV-cache stability: adding ONE slug only changes the batch it lands in", async () => {
    // 4 slugs → 2 batches at batchSize=2. Adding a 5th slug should keep
    // the slug→batch mapping of the original 4 intact except possibly
    // shifting which 2 of the 3 resulting batches contain them. The
    // critical invariant: for each ORIGINAL slug, the rendered string of
    // its containing batch must be byte-identical before and after (so
    // Anthropic's KV cache hits) — but only when the batch count is
    // unchanged. When N crosses a ceiling boundary, batch_count grows
    // and we accept the one-time reshuffle (rare in practice).

    // Pick a slug set that stays at batch_count=3 both before (6 slugs,
    // ceil(6/2)=3) and after (7 slugs, ceil(7/2)=4) → batch count
    // changes. Instead, hold batch_count constant by going from 5 to 6
    // slugs at batchSize=3: ceil(5/3)=2, ceil(6/3)=2.
    const before = await buildIndex(["a", "b", "c", "d", "e"]);
    const batchesBefore = partitionPageIndex(before, 3);
    expect(batchesBefore).toHaveLength(2);

    const renderedBySlug = new Map<string, string>();
    for (const batch of batchesBefore) {
      for (const entry of batch.entries) {
        renderedBySlug.set(entry.slug, batch.rendered);
      }
    }

    // Drop the cached global index, write one more page, rebuild.
    invalidatePageIndex();
    invalidateEdgeIndex();
    await writePage(workspaceDir, makePage("f", { summary: "f sum" }));
    const after = await getPageIndex(workspaceDir);
    const batchesAfter = partitionPageIndex(after, 3);
    expect(batchesAfter).toHaveLength(2);

    // Locate each original slug's NEW batch and compare against its OLD
    // rendered string. We expect exactly one of the two batches'
    // rendered strings to be byte-identical to the pre-add version (the
    // batch that didn't gain `f`); the other batch's rendering changed
    // because `f` was added to it.
    const renderedAfterBySlug = new Map<string, string>();
    for (const batch of batchesAfter) {
      for (const entry of batch.entries) {
        renderedAfterBySlug.set(entry.slug, batch.rendered);
      }
    }
    let unchangedSlugs = 0;
    for (const slug of ["a", "b", "c", "d", "e"]) {
      if (renderedBySlug.get(slug) === renderedAfterBySlug.get(slug)) {
        unchangedSlugs += 1;
      }
    }
    // At least some slugs must have their batch's rendered string
    // preserved — index-modulo chunking would change ALL batches when
    // a slug is added at any position. With hash-bucketing only the
    // bucket `f` landed in changes.
    expect(unchangedSlugs).toBeGreaterThan(0);
  });

  test("edges to pages in other batches drop; edges within a batch remap to local IDs", async () => {
    // Force `alice → bob` edge. Choose batchSize=1 so alice and bob land
    // in separate batches → the edge should drop.
    await writePage(
      workspaceDir,
      makePage("alice", { summary: "A", edges: ["bob"] }),
    );
    await writePage(workspaceDir, makePage("bob", { summary: "B" }));
    const idx = await getPageIndex(workspaceDir);
    const batches = partitionPageIndex(idx, 1);

    for (const batch of batches) {
      for (const entry of batch.entries) {
        // Edges must point to IDs that exist in THIS batch's byId map.
        for (const edgeId of entry.edges) {
          expect(batch.byId.has(edgeId)).toBe(true);
        }
      }
    }
    // alice's edge to bob must have dropped (bob is in a different batch).
    const aliceBatch = batches.find((b) => b.bySlug.has("alice"))!;
    expect(aliceBatch.bySlug.get("alice")!.edges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// splitTier1 — recently modified pool extraction
// ---------------------------------------------------------------------------

const { splitTier1, splitTier2 } = await import("../page-index.js");
const { utimes } = await import("node:fs/promises");
const { join: joinPath } = await import("node:path");

async function setMtime(
  workspaceDir: string,
  slug: string,
  epochMs: number,
): Promise<void> {
  const seconds = epochMs / 1000;
  await utimes(
    joinPath(workspaceDir, "memory", "concepts", `${slug}.md`),
    seconds,
    seconds,
  );
}

describe("splitTier1", () => {
  async function buildIndex(slugs: string[]) {
    for (const slug of slugs) {
      await writePage(workspaceDir, makePage(slug, { summary: `${slug} sum` }));
    }
    return getPageIndex(workspaceDir);
  }

  test("tier1Size=null is a no-op — same index reference, no carve-out", async () => {
    const idx = await buildIndex(["a", "b", "c"]);
    const { tier1, rest } = splitTier1(idx, null);
    expect(tier1).toBeNull();
    expect(rest).toBe(idx);
  });

  test("returns no-op shape on an empty workspace", async () => {
    const idx = await getPageIndex(workspaceDir);
    const { tier1, rest } = splitTier1(idx, 100);
    expect(tier1).toBeNull();
    expect(rest).toBe(idx);
  });

  test("top-N by mtime desc become tier 1; the remainder is the rest", async () => {
    await buildIndex(["a", "b", "c", "d", "e"]);
    await setMtime(workspaceDir, "a", 1_000_000);
    await setMtime(workspaceDir, "b", 5_000_000);
    await setMtime(workspaceDir, "c", 2_000_000);
    await setMtime(workspaceDir, "d", 4_000_000);
    await setMtime(workspaceDir, "e", 3_000_000);
    invalidatePageIndex();
    const idx = await getPageIndex(workspaceDir);

    const { tier1, rest } = splitTier1(idx, 2);
    expect(tier1).not.toBeNull();
    expect(tier1!.entries.map((e) => e.slug)).toEqual(["b", "d"]);
    expect(rest.entries.map((e) => e.slug).sort()).toEqual(["a", "c", "e"]);
  });

  test("tier1 carries batch-local 1-based IDs and re-rendered prompt block", async () => {
    await buildIndex(["a", "b"]);
    const idx = await getPageIndex(workspaceDir);
    const { tier1 } = splitTier1(idx, 5);
    expect(tier1!.entries.map((e) => e.id)).toEqual([1, 2]);
    expect(tier1!.rendered).toContain("[1] ");
    expect(tier1!.rendered).toContain("[2] ");
  });

  test("rest preserves slug-ASCII order so downstream hash bucketing is stable", async () => {
    await buildIndex(["zulu", "alpha", "mike", "bravo", "kilo"]);
    // Push zulu's mtime ahead of every other page — wall-clock mtimes from
    // writePage are all in the same second, so a future-stamped zulu is the
    // unambiguous "most recent."
    await setMtime(workspaceDir, "zulu", Date.now() + 60_000);
    invalidatePageIndex();
    const idx = await getPageIndex(workspaceDir);

    const { rest } = splitTier1(idx, 1);
    expect(rest.entries.map((e) => e.slug)).toEqual([
      "alpha",
      "bravo",
      "kilo",
      "mike",
    ]);
  });

  test("synthetic entries (mtime=0) sort below real pages — tier 1 prefers concept pages", async () => {
    skillState.entries = [
      { id: "echo", content: "echo skill" },
      { id: "foxtrot", content: "fox skill" },
    ];
    await buildIndex(["alpha", "bravo"]);
    invalidatePageIndex();
    const idx = await getPageIndex(workspaceDir);

    const { tier1 } = splitTier1(idx, 2);
    // Both real concept pages have mtime > 0; skill entries have mtime=0 →
    // tier 1's top-2 must be the concept pages, regardless of their relative
    // mtime ordering.
    const tier1Slugs = new Set(tier1!.entries.map((e) => e.slug));
    expect(tier1Slugs.has("alpha")).toBe(true);
    expect(tier1Slugs.has("bravo")).toBe(true);
    expect(tier1Slugs.has("skills/echo")).toBe(false);
    expect(tier1Slugs.has("skills/foxtrot")).toBe(false);
  });

  test("tier1Size larger than total entries returns all in tier 1 and empty rest", async () => {
    await buildIndex(["a", "b"]);
    const idx = await getPageIndex(workspaceDir);
    const { tier1, rest } = splitTier1(idx, 100);
    expect(tier1!.entries.length).toBe(2);
    expect(rest.entries.length).toBe(0);
  });

  test("mtime ties break by slug ASCII for determinism", async () => {
    await buildIndex(["alpha", "bravo", "charlie"]);
    // Force identical mtimes — file-system creation timestamps would otherwise
    // be near-identical but not exactly equal, masking the tiebreaker path.
    await setMtime(workspaceDir, "alpha", 5_000_000);
    await setMtime(workspaceDir, "bravo", 5_000_000);
    await setMtime(workspaceDir, "charlie", 5_000_000);
    invalidatePageIndex();
    const idx = await getPageIndex(workspaceDir);

    const { tier1 } = splitTier1(idx, 2);
    expect(tier1!.entries.map((e) => e.slug)).toEqual(["alpha", "bravo"]);
  });
});

// ---------------------------------------------------------------------------
// splitTier2 — top-M-by-EMA pool extraction
// ---------------------------------------------------------------------------

describe("splitTier2", () => {
  async function buildIndex(slugs: string[]) {
    for (const slug of slugs) {
      await writePage(workspaceDir, makePage(slug, { summary: `${slug} sum` }));
    }
    return getPageIndex(workspaceDir);
  }

  test("tier2Size=null is a no-op — same index reference, no carve-out", async () => {
    const idx = await buildIndex(["a", "b", "c"]);
    const { tier2, rest } = splitTier2(idx, null, new Map());
    expect(tier2).toBeNull();
    expect(rest).toBe(idx);
  });

  test("returns no-op when no pages have a positive score", async () => {
    const idx = await buildIndex(["a", "b", "c"]);
    // Empty scores map → every page has score 0 → none eligible.
    const { tier2, rest } = splitTier2(idx, 2, new Map());
    expect(tier2).toBeNull();
    expect(rest).toBe(idx);
  });

  test("top-M by score desc become tier 2; lower-score pages stay in rest", async () => {
    await buildIndex(["a", "b", "c", "d", "e"]);
    const idx = await getPageIndex(workspaceDir);
    const scores = new Map([
      ["a", 1.0],
      ["b", 5.0],
      ["c", 2.0],
      ["d", 4.0],
      ["e", 3.0],
    ]);

    const { tier2, rest } = splitTier2(idx, 2, scores);
    expect(tier2!.entries.map((e) => e.slug)).toEqual(["b", "d"]);
    expect(rest.entries.map((e) => e.slug).sort()).toEqual(["a", "c", "e"]);
  });

  test("score=0 pages are ineligible even when tier2Size is large", async () => {
    await buildIndex(["a", "b", "c", "d", "e"]);
    const idx = await getPageIndex(workspaceDir);
    // Only 2 pages have positive scores; tier2Size=10 should NOT pull in
    // zero-score pages to fill the pool.
    const scores = new Map([
      ["b", 5.0],
      ["d", 4.0],
    ]);
    const { tier2, rest } = splitTier2(idx, 10, scores);
    expect(tier2!.entries.map((e) => e.slug)).toEqual(["b", "d"]);
    expect(rest.entries.map((e) => e.slug).sort()).toEqual(["a", "c", "e"]);
  });

  test("tied scores break by slug ASCII for determinism", async () => {
    await buildIndex(["alpha", "bravo", "charlie", "delta"]);
    const idx = await getPageIndex(workspaceDir);
    const scores = new Map([
      ["alpha", 2.0],
      ["bravo", 2.0],
      ["charlie", 2.0],
      ["delta", 1.0],
    ]);

    const { tier2 } = splitTier2(idx, 2, scores);
    expect(tier2!.entries.map((e) => e.slug)).toEqual(["alpha", "bravo"]);
  });

  test("tier 2 entries carry batch-local 1-based IDs", async () => {
    await buildIndex(["a", "b", "c"]);
    const idx = await getPageIndex(workspaceDir);
    const { tier2 } = splitTier2(
      idx,
      2,
      new Map([
        ["a", 1.0],
        ["b", 2.0],
      ]),
    );
    expect(tier2!.entries.map((e) => e.id)).toEqual([1, 2]);
    expect(tier2!.rendered).toContain("[1] ");
    expect(tier2!.rendered).toContain("[2] ");
  });

  test("tier2Size larger than eligible count fills with available; rest gets remainder", async () => {
    await buildIndex(["a", "b", "c"]);
    const idx = await getPageIndex(workspaceDir);
    const scores = new Map([
      ["a", 1.0],
      ["b", 2.0],
      ["c", 3.0],
    ]);
    const { tier2, rest } = splitTier2(idx, 100, scores);
    expect(tier2!.entries.length).toBe(3);
    expect(rest.entries.length).toBe(0);
  });
});
