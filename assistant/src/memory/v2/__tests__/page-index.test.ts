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

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";
import type { ConceptPage, SkillEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Mocks — programmable skill list, programmable readPage failure set,
// recursive no-op logger. Mocks are installed BEFORE any imports of the
// module under test so the page-index module observes them at load time.
// ---------------------------------------------------------------------------

const skillState: { entries: SkillEntry[] } = { entries: [] };
const failingSlugs = new Set<string>();

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

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

const { getPageIndex, invalidatePageIndex } = await import("../page-index.js");
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
  opts: { edges?: string[]; summary?: string; body?: string } = {},
): ConceptPage {
  return {
    slug,
    frontmatter: {
      edges: opts.edges ?? [],
      ref_files: [],
      ref_urls: [],
      ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
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
