import { afterEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../../../../__tests__/feature-flag-test-helpers.js";
import type { AssistantConfig } from "../../../../config/types.js";
import type { MemoryJob } from "../../../../memory/jobs-store.js";
import { renderCapabilityContent } from "../capabilities.js";
import {
  backfillAllSections,
  type BackfillJobDeps,
  type ChangedPageCandidate,
  computeChangedPages,
  maintainJob,
  type MaintainJobDeps,
} from "../maintain-job.js";
import { buildSectionIndex } from "../sections.js";
import type { Section, SectionIndex, Slug } from "../types.js";

const FLAG_SHADOW = "memory-v3-shadow";
const FLAG_LIVE = "memory-v3-live";

// The flag resolver ignores the passed config and reads the override cache; the
// config arg only satisfies the signature. Flags are driven via
// `setOverridesForTesting` below.
const CONFIG = {} as AssistantConfig;

function makeSection(article: Slug, ordinal: number): Section {
  return {
    article,
    title: "",
    text: `text for ${article}#${ordinal}`,
    ordinal,
  };
}

function makeIndex(slugs: Slug[]): SectionIndex {
  const sections: Section[] = slugs.map((slug) => makeSection(slug, 0));
  const byArticle = new Map<Slug, number[]>();
  sections.forEach((s, i) => byArticle.set(s.article, [i]));
  return { sections, byArticle };
}

const JOB = { id: "job-1", type: "memory_v3_maintain" } as unknown as MemoryJob;

describe("maintainJob", () => {
  afterEach(() => {
    setOverridesForTesting({});
  });

  function deps(overrides: Partial<MaintainJobDeps> = {}): {
    deps: MaintainJobDeps;
    calls: {
      built: Slug[][];
      deleted: string[];
      upserted: Section[][];
      invalidate: number;
      commit: number;
    };
  } {
    const calls = {
      built: [] as Slug[][],
      deleted: [] as string[],
      upserted: [] as Section[][],
      invalidate: 0,
      commit: 0,
    };
    const base: MaintainJobDeps = {
      config: CONFIG,
      selectChangedPages: async () => [],
      buildSectionIndex: async (slugs) => {
        calls.built.push(slugs);
        return makeIndex(slugs);
      },
      readPageBody: async (slug) => `body for ${slug}`,
      deleteSectionsForArticle: async (_config, article) => {
        calls.deleted.push(article);
      },
      upsertSections: async (_config, sections) => {
        calls.upserted.push(sections);
      },
      commitEmbedHighWater: () => {
        calls.commit += 1;
      },
      // Prune stage off by default: no stored articles ⇒ nothing to prune. The
      // dedicated prune tests below override both collaborators.
      listSectionArticles: async () => [],
      listIndexedSlugs: async () => [],
      // Core-validation stage off by default: empty core set ⇒ nothing to
      // check. The dedicated core tests below override this.
      loadCoreSet: () => [],
      invalidateLanes: () => {
        calls.invalidate += 1;
      },
    };
    return { deps: { ...base, ...overrides }, calls };
  }

  test("no-op when both v3 flags are off", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: false, [FLAG_LIVE]: false });
    const { deps: d, calls } = deps({
      selectChangedPages: async () => ["page-a"],
    });
    const outcome = await maintainJob(JOB, CONFIG, d);
    expect(outcome.disabled).toBe(true);
    expect(calls.built.length).toBe(0);
    expect(calls.invalidate).toBe(0);
  });

  test("re-chunks + re-embeds changed pages and invalidates lanes (shadow on)", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d, calls } = deps({
      selectChangedPages: async () => ["page-a", "page-b"],
    });
    const outcome = await maintainJob(JOB, CONFIG, d);

    expect(outcome.disabled).toBe(false);
    expect(outcome.reembedded).toBe(2);
    expect(outcome.reembedFailures).toBe(0);
    expect(outcome.invalidated).toBe(true);

    // Each changed page: delete its stale sections, then upsert fresh ones.
    expect(calls.built).toEqual([["page-a"], ["page-b"]]);
    expect(calls.deleted).toEqual(["page-a", "page-b"]);
    expect(calls.upserted.flat().map((s) => s.article)).toEqual([
      "page-a",
      "page-b",
    ]);
    expect(calls.invalidate).toBe(1);
    expect(calls.commit).toBe(1);
  });

  test("runs when only the live flag is on", async () => {
    setOverridesForTesting({ [FLAG_LIVE]: true });
    const { deps: d, calls } = deps({
      selectChangedPages: async () => ["page-a"],
    });
    await maintainJob(JOB, CONFIG, d);
    expect(calls.built).toEqual([["page-a"]]);
    expect(calls.invalidate).toBe(1);
  });

  test("skips the dense store entirely when no pages changed", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d, calls } = deps({ selectChangedPages: async () => [] });
    const outcome = await maintainJob(JOB, CONFIG, d);
    expect(outcome.reembedded).toBe(0);
    expect(calls.built.length).toBe(0);
    expect(calls.deleted.length).toBe(0);
    expect(calls.upserted.length).toBe(0);
    // The pass still advances the high-water mark and invalidates lanes.
    expect(calls.commit).toBe(1);
    expect(calls.invalidate).toBe(1);
  });

  test("a single failing page is contained; other pages still re-embed", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d, calls } = deps({
      selectChangedPages: async () => ["page-ok", "page-bad", "page-ok-2"],
      upsertSections: async (_config, sections) => {
        if (sections.some((s) => s.article === "page-bad")) {
          throw new Error("embed boom");
        }
        calls.upserted.push(sections);
      },
    });
    const outcome = await maintainJob(JOB, CONFIG, d);

    expect(outcome.reembedded).toBe(2);
    expect(outcome.reembedFailures).toBe(1);
    // Both good pages were upserted; the lanes were still invalidated.
    expect(calls.upserted.flat().map((s) => s.article)).toEqual([
      "page-ok",
      "page-ok-2",
    ]);
    expect(calls.invalidate).toBe(1);
    expect(outcome.invalidated).toBe(true);
    // The checkpoint is HELD when any page failed: the failed page was
    // delete-then-upsert'd (so its sections are gone), and advancing past its
    // mtime would hide it from `computeChangedPages` forever. Holding the mark
    // lets the next pass re-select and re-embed it.
    expect(calls.commit).toBe(0);
  });

  test("a thrown re-embed stage does not abort lane invalidation", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d, calls } = deps({
      selectChangedPages: async () => {
        throw new Error("select boom");
      },
    });
    const outcome = await maintainJob(JOB, CONFIG, d);
    expect(outcome.failures).toContain("reembed");
    expect(calls.commit).toBe(0);
    expect(calls.invalidate).toBe(1);
    expect(outcome.invalidated).toBe(true);
  });

  test("advances the high-water mark after a successful re-embed pass", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d, calls } = deps({
      selectChangedPages: async () => ["page-a"],
    });
    await maintainJob(JOB, CONFIG, d);
    expect(calls.commit).toBe(1);
  });

  test("does not advance the high-water mark when selection throws", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d, calls } = deps({
      selectChangedPages: async () => {
        throw new Error("select boom");
      },
    });
    const outcome = await maintainJob(JOB, CONFIG, d);
    expect(outcome.failures).toContain("reembed");
    expect(calls.commit).toBe(0);
  });

  test("prunes sections for an article absent from the page index", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    // The dense store holds points for a live page, a deleted page, and a
    // synthetic capability row; the page index holds only the live + synthetic
    // slugs. Only the deleted page's sections are pruned. `selectChangedPages`
    // stays empty so `calls.deleted` reflects prune deletes only.
    const { deps: d, calls } = deps({
      listSectionArticles: async () => [
        "page-live",
        "page-deleted",
        "skills/example",
      ],
      listIndexedSlugs: async () => ["page-live", "skills/example"],
    });
    const outcome = await maintainJob(JOB, CONFIG, d);

    expect(outcome.pruned).toBe(1);
    expect(outcome.pruneFailures).toBe(0);
    // The live page and the synthetic capability row are NOT pruned.
    expect(calls.deleted).toEqual(["page-deleted"]);
    // The pass still invalidates the lanes.
    expect(calls.invalidate).toBe(1);
    expect(outcome.invalidated).toBe(true);
  });

  test("prunes nothing when every stored article is still in the index", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d, calls } = deps({
      listSectionArticles: async () => ["page-a", "page-b"],
      listIndexedSlugs: async () => ["page-a", "page-b", "page-c"],
    });
    const outcome = await maintainJob(JOB, CONFIG, d);

    expect(outcome.pruned).toBe(0);
    expect(calls.deleted).toEqual([]);
  });

  test("a single failing prune delete is contained; other deletions proceed", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d, calls } = deps({
      listSectionArticles: async () => ["gone-1", "gone-bad", "gone-2"],
      listIndexedSlugs: async () => [],
      deleteSectionsForArticle: async (_config, article) => {
        if (article === "gone-bad") throw new Error("delete boom");
        calls.deleted.push(article);
      },
    });
    const outcome = await maintainJob(JOB, CONFIG, d);

    expect(outcome.pruned).toBe(2);
    expect(outcome.pruneFailures).toBe(1);
    // Both good deletions ran; the contained failure did not abort them.
    expect(calls.deleted).toEqual(["gone-1", "gone-2"]);
    // A contained per-article failure is NOT a stage failure, and the lanes
    // were still invalidated.
    expect(outcome.failures).not.toContain("prune");
    expect(calls.invalidate).toBe(1);
  });

  test("reports dangling core entries without mutating anything", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    // The core file lists a live page, a renamed/deleted page, and a synthetic
    // capability slug; only the missing page is reported. The stage is
    // report-only: no deletes, no upserts, and the maintainer-owned file is
    // untouched (the injected loader is read-only by construction).
    const { deps: d, calls } = deps({
      loadCoreSet: () => ["page-live", "page-gone", "skills/example"],
      listIndexedSlugs: async () => ["page-live", "skills/example"],
    });
    const outcome = await maintainJob(JOB, CONFIG, d);

    expect(outcome.danglingCoreSlugs).toEqual(["page-gone"]);
    expect(outcome.failures).toEqual([]);
    // Report-only: the dangling entry triggered no dense-store mutation.
    expect(calls.deleted).toEqual([]);
    expect(calls.upserted).toEqual([]);
    // The pass still invalidates the lanes.
    expect(calls.invalidate).toBe(1);
  });

  test("reports nothing when every core entry is still in the index", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d } = deps({
      loadCoreSet: () => ["page-a", "page-b"],
      listIndexedSlugs: async () => ["page-a", "page-b", "page-c"],
    });
    const outcome = await maintainJob(JOB, CONFIG, d);
    expect(outcome.danglingCoreSlugs).toEqual([]);
  });

  test("an empty core set skips validation entirely", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    let indexReads = 0;
    const { deps: d } = deps({
      loadCoreSet: () => [],
      listIndexedSlugs: async () => {
        indexReads += 1;
        return [];
      },
    });
    const outcome = await maintainJob(JOB, CONFIG, d);
    expect(outcome.danglingCoreSlugs).toEqual([]);
    // The prune stage reads the index once; the core stage adds no second read.
    expect(indexReads).toBe(1);
  });

  test("a thrown core-validation stage is contained and does not abort lane invalidation", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d, calls } = deps({
      loadCoreSet: () => {
        throw new Error("core boom");
      },
    });
    const outcome = await maintainJob(JOB, CONFIG, d);

    expect(outcome.failures).toContain("core-validate");
    expect(outcome.danglingCoreSlugs).toEqual([]);
    expect(calls.invalidate).toBe(1);
    expect(outcome.invalidated).toBe(true);
  });

  test("a thrown prune stage is contained and does not abort lane invalidation", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d, calls } = deps({
      listSectionArticles: async () => {
        throw new Error("scroll boom");
      },
    });
    const outcome = await maintainJob(JOB, CONFIG, d);

    expect(outcome.failures).toContain("prune");
    expect(outcome.pruned).toBe(0);
    // Invalidation still runs after a thrown prune stage.
    expect(calls.invalidate).toBe(1);
    expect(outcome.invalidated).toBe(true);
  });
});

describe("computeChangedPages", () => {
  const page = (slug: string, modifiedAt: number): ChangedPageCandidate => ({
    slug,
    modifiedAt,
  });

  test("first run (null high-water) selects every real page", () => {
    const changed = computeChangedPages(
      [page("page-a", 100), page("page-b", 200)],
      null,
    );
    expect(changed).toEqual(["page-a", "page-b"]);
  });

  test("selects only pages edited since the high-water", () => {
    const changed = computeChangedPages(
      [page("stale", 150), page("fresh", 300)],
      200,
    );
    expect(changed).toEqual(["fresh"]);
  });

  test("skips a page untouched since the high-water (no self-trigger)", () => {
    const changed = computeChangedPages([page("stale", 150)], 200);
    expect(changed).toEqual([]);
  });

  test("excludes synthetic skill/CLI rows (modifiedAt 0)", () => {
    const changed = computeChangedPages(
      [page("skills/meet-join", 0), page("real", 300)],
      200,
    );
    expect(changed).toEqual(["real"]);
  });

  test("excludes synthetic rows even on the first run", () => {
    const changed = computeChangedPages(
      [page("skills/x", 0), page("real", 10)],
      null,
    );
    expect(changed).toEqual(["real"]);
  });
});

describe("backfillAllSections", () => {
  afterEach(() => {
    setOverridesForTesting({});
  });

  function deps(overrides: Partial<BackfillJobDeps> = {}): {
    deps: BackfillJobDeps;
    calls: {
      ensured: number;
      built: Slug[][];
      deleted: string[];
      upserted: Section[][];
      committed: number[];
    };
  } {
    const calls = {
      ensured: 0,
      built: [] as Slug[][],
      deleted: [] as string[],
      upserted: [] as Section[][],
      committed: [] as number[],
    };
    const base: BackfillJobDeps = {
      config: CONFIG,
      selectAllPages: async () => [],
      ensureSectionCollection: async () => {
        calls.ensured += 1;
      },
      // Real builder + chunker so the synthetic capability content is genuinely
      // turned into section points (not a hand-rolled stub).
      buildSectionIndex: async (slugs, pageBody) => {
        calls.built.push(slugs);
        return buildSectionIndex(slugs, pageBody);
      },
      readPageBody: async (slug) => `body for ${slug}`,
      deleteSectionsForArticle: async (_config, article) => {
        calls.deleted.push(article);
      },
      upsertSections: async (_config, sections) => {
        calls.upserted.push(sections);
      },
      commitEmbedHighWater: (ms) => {
        calls.committed.push(ms);
      },
      nowMs: () => 4242,
    };
    return { deps: { ...base, ...overrides }, calls };
  }

  test("embeds EVERY page incl a synthetic capability slug, with its capability content", async () => {
    // A capability-aware reader, exactly as the production default deps wire it:
    // the real renderer resolves the synthetic skill row's content (injected
    // resolvers keep it deterministic, mirroring `capabilities.test.ts`).
    const resolvers = {
      skill: (slug: Slug) =>
        slug === "skills/example"
          ? { id: "example", content: "example capability body" }
          : null,
      cli: () => null,
    };
    const readPageBody = async (slug: Slug): Promise<string> =>
      renderCapabilityContent(slug, resolvers) ?? `body for ${slug}`;

    const { deps: d, calls } = deps({
      selectAllPages: async () => ["page-a", "skills/example"],
      readPageBody,
    });
    const outcome = await backfillAllSections(CONFIG, d);

    // Both the real page AND the synthetic capability row were embedded.
    expect(outcome.articles).toBe(2);
    expect(outcome.failures).toBe(0);
    expect(calls.ensured).toBe(1);
    expect(calls.built).toEqual([["page-a"], ["skills/example"]]);
    expect(calls.deleted).toEqual(["page-a", "skills/example"]);

    // The synthetic slug's upsert carries its rendered capability content, not a
    // blank/on-disk read.
    const syntheticSections = calls.upserted
      .flat()
      .filter((s) => s.article === "skills/example");
    expect(syntheticSections.length).toBeGreaterThan(0);
    expect(syntheticSections.map((s) => s.text).join("\n")).toContain(
      "example capability body",
    );
    expect(outcome.sections).toBe(calls.upserted.flat().length);
  });

  test("advances the high-water checkpoint to the injected now", async () => {
    const { deps: d, calls } = deps({
      selectAllPages: async () => ["page-a"],
      nowMs: () => 99999,
    });
    await backfillAllSections(CONFIG, d);
    expect(calls.committed).toEqual([99999]);
  });

  test("contains a single failing page; others still embed but checkpoint is HELD", async () => {
    const { deps: d, calls } = deps({
      selectAllPages: async () => ["page-ok", "page-bad", "page-ok-2"],
      upsertSections: async (_config, sections) => {
        if (sections.some((s) => s.article === "page-bad")) {
          throw new Error("embed boom");
        }
        calls.upserted.push(sections);
      },
    });
    const outcome = await backfillAllSections(CONFIG, d);

    expect(outcome.articles).toBe(2);
    expect(outcome.failures).toBe(1);
    expect(calls.upserted.flat().map((s) => s.article)).toEqual([
      "page-ok",
      "page-ok-2",
    ]);
    // The checkpoint is HELD on any failure: the failed page was
    // delete-then-upsert'd (sections gone), so advancing past its mtime would
    // hide it from the incremental selector forever. Holding the mark lets the
    // next pass re-embed it.
    expect(calls.committed).toEqual([]);
  });

  test("capability row that renders empty embeds on the post-loop retry once the store seeds", async () => {
    // Models the startup race: the skill store is cold when the main loop
    // reaches the capability row (renders ""), and has seeded by the time the
    // retry pass runs.
    let skillReads = 0;
    const readPageBody = async (slug: Slug): Promise<string> => {
      if (slug === "skills/example") {
        skillReads += 1;
        return skillReads === 1
          ? ""
          : "# Skill: example\nexample capability body";
      }
      return `body for ${slug}`;
    };

    const { deps: d, calls } = deps({
      selectAllPages: async () => ["skills/example", "page-a"],
      readPageBody,
    });
    const outcome = await backfillAllSections(CONFIG, d);

    // The cold row was skipped without building on the first pass, then built
    // and embedded on the retry.
    expect(calls.built).toEqual([["page-a"], ["skills/example"]]);
    // The cold render never deleted the row's existing points; the retry did.
    expect(calls.deleted).toEqual(["page-a", "skills/example"]);
    expect(
      calls.upserted.flat().filter((s) => s.article === "skills/example")
        .length,
    ).toBeGreaterThan(0);
    expect(outcome.articles).toBe(2);
    expect(outcome.failures).toBe(0);
    expect(calls.committed).toEqual([4242]);
  });

  test("capability row still empty after retry is a failure: never deleted, checkpoint HELD", async () => {
    const { deps: d, calls } = deps({
      selectAllPages: async () => ["page-a", "skills/example"],
      readPageBody: async (slug) =>
        slug === "skills/example" ? "" : `body for ${slug}`,
    });
    const outcome = await backfillAllSections(CONFIG, d);

    // The empty render must never wipe previously-good points with nothing.
    expect(calls.deleted).toEqual(["page-a"]);
    expect(
      calls.upserted.flat().filter((s) => s.article === "skills/example"),
    ).toEqual([]);
    expect(outcome.articles).toBe(1);
    expect(outcome.failures).toBe(1);
    expect(calls.committed).toEqual([]);
  });

  test("capability row missing from the first index snapshot is swept up after the main loop", async () => {
    // Models the other face of the startup race: the capability store had not
    // listed its rows in the page index yet when `selectAllPages` first ran,
    // and has by the time the pass re-enumerates.
    let listCalls = 0;
    const { deps: d, calls } = deps({
      selectAllPages: async () => {
        listCalls += 1;
        return listCalls === 1 ? ["page-a"] : ["page-a", "skills/example"];
      },
      readPageBody: async (slug) =>
        slug === "skills/example"
          ? "# Skill: example\nexample capability body"
          : `body for ${slug}`,
    });
    const outcome = await backfillAllSections(CONFIG, d);

    expect(listCalls).toBe(2);
    // Only the late CAPABILITY row is swept in; page-a is not re-embedded.
    expect(calls.built).toEqual([["page-a"], ["skills/example"]]);
    expect(calls.deleted).toEqual(["page-a", "skills/example"]);
    expect(outcome.articles).toBe(2);
    expect(outcome.failures).toBe(0);
    expect(calls.committed).toEqual([4242]);
  });

  test("a real page with an empty body still empties its sections (capability guard does not apply)", async () => {
    const { deps: d, calls } = deps({
      selectAllPages: async () => ["page-empty"],
      readPageBody: async () => "",
    });
    const outcome = await backfillAllSections(CONFIG, d);

    // Existing behavior for on-disk pages: an empty body still replaces the
    // page's sections (the chunker synthesizes a minimal head section) — only
    // capability rows treat an empty body as "store not seeded".
    expect(calls.deleted).toEqual(["page-empty"]);
    expect(outcome.articles).toBe(1);
    expect(outcome.failures).toBe(0);
    expect(calls.committed).toEqual([4242]);
  });
});
