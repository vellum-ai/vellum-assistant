import { afterEach, describe, expect, mock, test } from "bun:test";

import type { SkillSummary } from "../../../../../config/skills.js";
import type { AssistantConfig } from "../../../../../config/types.js";
import { EmbeddingBackendUnavailableError } from "../../../../../persistence/embeddings/embedding-backend.js";
import { EmbeddingBillingBlockError } from "../../../../../persistence/embeddings/embedding-billing-breaker.js";
import type { MemoryJob } from "../../../../../persistence/jobs-store.js";
import type { SkillInstallMeta } from "../../../../../skills/install-meta.js";
import { skillSlugFor } from "../../v2/skill-store.js";
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

// The skill usage-prune stage reads `memory.maintenance.skillPruneDays`; default
// it off (null = never delete) and override per prune test.
function makeConfig(skillPruneDays: number | null = null): AssistantConfig {
  return {
    memory: { maintenance: { skillPruneDays } },
  } as unknown as AssistantConfig;
}

// v3-live (config-gated) is driven through the `isMemoryV3Live` mock slot below;
// the config arg otherwise only carries the maintenance branch the prune stage
// reads (default off — null = never delete).
const CONFIG = makeConfig();

let memoryV3LiveSlot = false;
mock.module("../../../../../config/memory-v3-gate.js", () => ({
  isMemoryV3Live: () => memoryV3LiveSlot,
}));

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
    memoryV3LiveSlot = false;
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
      ensureSectionCollection: async () => {},
      selectChangedPages: async () => [],
      buildSectionIndex: async (slugs) => {
        calls.built.push(slugs);
        return makeIndex(slugs);
      },
      readPageBody: async (slug) => `body for ${slug}`,
      readCapabilityBody: async (slug) => `capability body for ${slug}`,
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
      // Skill usage-prune stage off by default: no managed skills ⇒ nothing to
      // report or delete. The dedicated usage-prune tests below override these.
      listManagedSkills: () => [],
      readSkillMeta: () => null,
      deleteSkill: async () => {},
      nowMs: () => Date.now(),
    };
    return { deps: { ...base, ...overrides }, calls };
  }

  test("ensures the section collection before selecting deltas", async () => {
    // A drift recreate inside ensureSectionCollection clears the embed
    // high-water; it must run before selectChangedPages reads the mark, or this
    // pass re-embeds only recent pages and the end-of-pass commit clobbers the
    // reset, stranding the rest. Assert the ordering that prevents that.
    memoryV3LiveSlot = true;
    const order: string[] = [];
    const { deps: d } = deps({
      ensureSectionCollection: async () => {
        order.push("ensure");
      },
      selectChangedPages: async () => {
        order.push("select");
        return [];
      },
    });

    await maintainJob(JOB, CONFIG, d);

    expect(order).toEqual(["ensure", "select"]);
  });

  test("no-op when v3 is disabled", async () => {
    const { deps: d, calls } = deps({
      selectChangedPages: async () => ["page-a"],
    });
    const outcome = await maintainJob(JOB, CONFIG, d);
    expect(outcome.disabled).toBe(true);
    expect(calls.built.length).toBe(0);
    expect(calls.invalidate).toBe(0);
  });

  test("re-chunks + re-embeds changed pages and invalidates lanes (live on)", async () => {
    memoryV3LiveSlot = true;
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
    memoryV3LiveSlot = true;
    const { deps: d, calls } = deps({
      selectChangedPages: async () => ["page-a"],
    });
    await maintainJob(JOB, CONFIG, d);
    expect(calls.built).toEqual([["page-a"]]);
    expect(calls.invalidate).toBe(1);
  });

  test("skips the dense store entirely when no pages changed", async () => {
    memoryV3LiveSlot = true;
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
    memoryV3LiveSlot = true;
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
    memoryV3LiveSlot = true;
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
    memoryV3LiveSlot = true;
    const { deps: d, calls } = deps({
      selectChangedPages: async () => ["page-a"],
    });
    await maintainJob(JOB, CONFIG, d);
    expect(calls.commit).toBe(1);
  });

  test("does not advance the high-water mark when selection throws", async () => {
    memoryV3LiveSlot = true;
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
    memoryV3LiveSlot = true;
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
    memoryV3LiveSlot = true;
    const { deps: d, calls } = deps({
      listSectionArticles: async () => ["page-a", "page-b"],
      listIndexedSlugs: async () => ["page-a", "page-b", "page-c"],
    });
    const outcome = await maintainJob(JOB, CONFIG, d);

    expect(outcome.pruned).toBe(0);
    expect(calls.deleted).toEqual([]);
  });

  test("a single failing prune delete is contained; other deletions proceed", async () => {
    memoryV3LiveSlot = true;
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
    memoryV3LiveSlot = true;
    // The core file lists a live page, a renamed/deleted page, and a synthetic
    // capability slug; only the missing page is reported. The stage is
    // report-only: no deletes, no upserts, and the maintainer-owned file is
    // untouched (the injected loader is read-only by construction).
    const { deps: d, calls } = deps({
      loadCoreSet: () => ["page-live", "page-gone", "skills/example"],
      listIndexedSlugs: async () => ["page-live", "skills/example"],
      // The capability row is already in the store, so the reconcile stage
      // no-ops here and this test exercises core-validation in isolation.
      listSectionArticles: async () => ["skills/example"],
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
    memoryV3LiveSlot = true;
    const { deps: d } = deps({
      loadCoreSet: () => ["page-a", "page-b"],
      listIndexedSlugs: async () => ["page-a", "page-b", "page-c"],
    });
    const outcome = await maintainJob(JOB, CONFIG, d);
    expect(outcome.danglingCoreSlugs).toEqual([]);
  });

  test("an empty core set skips validation entirely", async () => {
    memoryV3LiveSlot = true;
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
    // The reconcile and prune stages each read the index once; the empty core
    // stage adds no further read.
    expect(indexReads).toBe(2);
  });

  test("a thrown core-validation stage is contained and does not abort lane invalidation", async () => {
    memoryV3LiveSlot = true;
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
    memoryV3LiveSlot = true;
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

  test("reconciles capability rows missing from the section store", async () => {
    memoryV3LiveSlot = true;
    // The index lists a real page and three capability rows; the store already
    // holds one of the caps. The change-delta excludes capability rows, so
    // without this stage a skill enabled after the one-time backfill never
    // reaches the dense lane. selectChangedPages stays empty so `calls.built`
    // reflects reconcile embeds only.
    const { deps: d, calls } = deps({
      selectChangedPages: async () => [],
      listIndexedSlugs: async () => [
        "page-a",
        "skills/already",
        "skills/workflows",
        "skills/another",
      ],
      listSectionArticles: async () => ["page-a", "skills/already"],
    });
    const outcome = await maintainJob(JOB, CONFIG, d);

    // Only the caps missing from the store are embedded; the real page (handled
    // by the change-delta stage) and the already-stored cap are left alone.
    expect(outcome.capabilitiesReconciled).toBe(2);
    expect(outcome.reconcileFailures).toBe(0);
    expect(calls.built).toEqual([["skills/workflows"], ["skills/another"]]);
    expect(calls.deleted).toEqual(["skills/workflows", "skills/another"]);
    expect(calls.upserted.flat().map((s) => s.article)).toEqual([
      "skills/workflows",
      "skills/another",
    ]);
  });

  test("skips a cold capability row (empty body) without deleting its points", async () => {
    memoryV3LiveSlot = true;
    const { deps: d, calls } = deps({
      listIndexedSlugs: async () => ["skills/cold"],
      listSectionArticles: async () => [],
      readCapabilityBody: async () => "", // capability store not seeded yet
    });
    const outcome = await maintainJob(JOB, CONFIG, d);

    expect(outcome.capabilitiesReconciled).toBe(0);
    expect(outcome.reconcileFailures).toBe(0);
    // Never replace good points with a blank: no delete, no upsert.
    expect(calls.deleted).toEqual([]);
    expect(calls.upserted).toEqual([]);
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
    memoryV3LiveSlot = false;
  });

  function deps(overrides: Partial<BackfillJobDeps> = {}): {
    deps: BackfillJobDeps;
    calls: {
      ensured: number;
      built: Slug[][];
      deleted: string[];
      upserted: Section[][];
      committed: number[];
      probed: number;
    };
  } {
    const calls = {
      ensured: 0,
      built: [] as Slug[][],
      deleted: [] as string[],
      upserted: [] as Section[][],
      committed: [] as number[],
      probed: 0,
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
      embedProbe: async () => {
        calls.probed += 1;
      },
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

  test("aborts before any write when the pre-flight embed probe fails", async () => {
    const { deps: d, calls } = deps({
      selectAllPages: async () => ["page-a", "page-b"],
      embedProbe: async () => {
        throw new EmbeddingBackendUnavailableError();
      },
    });
    await expect(backfillAllSections(CONFIG, d)).rejects.toThrow(
      EmbeddingBackendUnavailableError,
    );
    // Nothing deleted, upserted, or committed — the corpus is untouched.
    expect(calls.deleted).toEqual([]);
    expect(calls.upserted).toEqual([]);
    expect(calls.committed).toEqual([]);
  });

  test("aborts the run when the embedding backend goes down mid-loop (does not delete the rest of the corpus)", async () => {
    // Healthy for the probe and the first article, then down. Without the abort,
    // every remaining article would be delete-then-failed (the original
    // incident): the backend-down state is process-wide.
    let upserts = 0;
    const { deps: d, calls } = deps({
      selectAllPages: async () => ["page-1", "page-2", "page-3", "page-4"],
      upsertSections: async (_config, sections) => {
        upserts += 1;
        if (upserts >= 2) throw new EmbeddingBackendUnavailableError();
        calls.upserted.push(sections);
      },
    });
    await expect(backfillAllSections(CONFIG, d)).rejects.toThrow(
      EmbeddingBackendUnavailableError,
    );
    // page-1 embedded; page-2's delete ran then its embed threw → ABORT. page-3
    // and page-4 are never touched, so their existing points stay intact.
    expect(calls.deleted).toEqual(["page-1", "page-2"]);
    expect(calls.upserted.flat().map((s) => s.article)).toEqual(["page-1"]);
    expect(calls.committed).toEqual([]);
  });

  test("aborts the run on a billing-breaker error mid-loop", async () => {
    const { deps: d, calls } = deps({
      selectAllPages: async () => ["page-1", "page-2"],
      upsertSections: async () => {
        throw new EmbeddingBillingBlockError();
      },
    });
    await expect(backfillAllSections(CONFIG, d)).rejects.toThrow(
      EmbeddingBillingBlockError,
    );
    // First article's delete ran, its embed threw → abort. Second never touched.
    expect(calls.deleted).toEqual(["page-1"]);
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

describe("maintainJob skill usage-prune", () => {
  const NOW = Date.parse("2026-06-22T00:00:00.000Z");

  afterEach(() => {
    memoryV3LiveSlot = false;
  });

  function skill(id: string): SkillSummary {
    return {
      id,
      name: id,
      displayName: id,
      description: "",
      directoryPath: `/skills/${id}`,
      skillFilePath: `/skills/${id}/SKILL.md`,
      source: "managed",
    };
  }

  /** Build install-meta `daysAgo` old via the chosen field. */
  function meta(
    author: SkillInstallMeta["author"] | undefined,
    field: "lastUsedAt" | "installedAt" | "none",
    daysAgo = 0,
  ): SkillInstallMeta {
    const ts = new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    const base: SkillInstallMeta = {
      origin: "custom",
      // A never-used skill (`field: "none"`) still needs an installedAt; make it
      // very old so it falls back to installedAt for the age math.
      installedAt: field === "lastUsedAt" ? new Date(NOW).toISOString() : ts,
    };
    if (author) base.author = author;
    if (field === "lastUsedAt") base.lastUsedAt = ts;
    return base;
  }

  /** Wire managed skills + their metas + an injected clock at NOW. */
  function pruneDeps(
    skills: SkillSummary[],
    metas: Record<string, SkillInstallMeta | null>,
    skillPruneDays: number | null,
    overrides: Partial<MaintainJobDeps> = {},
  ): {
    deps: MaintainJobDeps;
    deletedSkills: string[];
    sectionDeletes: string[];
  } {
    const deletedSkills: string[] = [];
    const sectionDeletes: string[] = [];
    const d: MaintainJobDeps = {
      config: makeConfig(skillPruneDays),
      ensureSectionCollection: async () => {},
      selectChangedPages: async () => [],
      buildSectionIndex: async (slugs) => makeIndex(slugs),
      readPageBody: async (s) => `body for ${s}`,
      readCapabilityBody: async (s) => `capability body for ${s}`,
      deleteSectionsForArticle: async (_config, article) => {
        sectionDeletes.push(article);
      },
      upsertSections: async () => {},
      commitEmbedHighWater: () => {},
      listSectionArticles: async () => [],
      listIndexedSlugs: async () => [],
      loadCoreSet: () => [],
      invalidateLanes: () => {},
      listManagedSkills: () => skills,
      readSkillMeta: (dir) => {
        const id = dir.split("/").pop()!;
        return metas[id] ?? null;
      },
      deleteSkill: async (id) => {
        deletedSkills.push(id);
      },
      nowMs: () => NOW,
      ...overrides,
    };
    return { deps: d, deletedSkills, sectionDeletes };
  }

  describe("default (skillPruneDays: null) — observe-only, deletes nothing", () => {
    test("reports stale assistant skills but deletes none", async () => {
      memoryV3LiveSlot = true;
      const skills = [skill("stale-assistant"), skill("fresh-assistant")];
      const { deps: d, deletedSkills } = pruneDeps(
        skills,
        {
          "stale-assistant": meta("assistant", "lastUsedAt", 90),
          "fresh-assistant": meta("assistant", "lastUsedAt", 1),
        },
        null,
      );
      const outcome = await maintainJob(JOB, CONFIG, d);

      // Default-off: nothing deleted even though one skill is 90 days stale.
      expect(deletedSkills).toEqual([]);
      expect(outcome.prunedSkills).toEqual([]);
      expect(outcome.skillPruneFailures).toEqual([]);
      // Observe-only report still surfaces the stale skill (≥ 30-day window).
      expect(outcome.prunableSkills).toEqual(["stale-assistant"]);
    });

    test("excludes author:user and untagged skills from prunableSkills", async () => {
      memoryV3LiveSlot = true;
      const skills = [
        skill("old-assistant"),
        skill("old-user"),
        skill("old-untagged"),
      ];
      const { deps: d, deletedSkills } = pruneDeps(
        skills,
        {
          "old-assistant": meta("assistant", "lastUsedAt", 90),
          "old-user": meta("user", "lastUsedAt", 90),
          "old-untagged": meta(undefined, "lastUsedAt", 90),
        },
        null,
      );
      const outcome = await maintainJob(JOB, CONFIG, d);

      expect(deletedSkills).toEqual([]);
      // Only the assistant-authored skill is reported; user + untagged protected.
      expect(outcome.prunableSkills).toEqual(["old-assistant"]);
    });
  });

  describe("enabled (skillPruneDays: 30) — deletes via executeDeleteManagedSkill", () => {
    test("prunes a stale assistant skill via deleteSkill", async () => {
      memoryV3LiveSlot = true;
      const {
        deps: d,
        deletedSkills,
        sectionDeletes,
      } = pruneDeps(
        [skill("stale-assistant")],
        { "stale-assistant": meta("assistant", "lastUsedAt", 45) },
        30,
      );
      const outcome = await maintainJob(JOB, CONFIG, d);

      expect(deletedSkills).toEqual(["stale-assistant"]);
      expect(outcome.prunedSkills).toEqual(["stale-assistant"]);
      expect(outcome.prunableSkills).toEqual(["stale-assistant"]);
      expect(outcome.skillPruneFailures).toEqual([]);
      // The pruned skill's v3 capability sections are cleared the same pass.
      expect(sectionDeletes).toContain(skillSlugFor("stale-assistant"));
    });

    test("never prunes author:user or untagged skills", async () => {
      memoryV3LiveSlot = true;
      const { deps: d, deletedSkills } = pruneDeps(
        [skill("old-user"), skill("old-untagged")],
        {
          "old-user": meta("user", "lastUsedAt", 999),
          "old-untagged": meta(undefined, "lastUsedAt", 999),
        },
        30,
      );
      const outcome = await maintainJob(JOB, CONFIG, d);

      expect(deletedSkills).toEqual([]);
      expect(outcome.prunedSkills).toEqual([]);
      expect(outcome.prunableSkills).toEqual([]);
    });

    test("keeps a recently-used assistant skill", async () => {
      memoryV3LiveSlot = true;
      const { deps: d, deletedSkills } = pruneDeps(
        [skill("fresh-assistant")],
        { "fresh-assistant": meta("assistant", "lastUsedAt", 5) },
        30,
      );
      const outcome = await maintainJob(JOB, CONFIG, d);

      expect(deletedSkills).toEqual([]);
      expect(outcome.prunedSkills).toEqual([]);
      // Under the 30-day observe window too, so not even reported.
      expect(outcome.prunableSkills).toEqual([]);
    });

    test("a never-used skill falls back to installedAt", async () => {
      memoryV3LiveSlot = true;
      // No lastUsedAt; installedAt is 60 days old ⇒ eligible at the 30-day
      // threshold via the installedAt fallback.
      const { deps: d, deletedSkills } = pruneDeps(
        [skill("never-used")],
        { "never-used": meta("assistant", "installedAt", 60) },
        30,
      );
      const outcome = await maintainJob(JOB, CONFIG, d);

      expect(deletedSkills).toEqual(["never-used"]);
      expect(outcome.prunedSkills).toEqual(["never-used"]);
    });

    test("a deleteSkill rejection lands in skillPruneFailures without aborting", async () => {
      memoryV3LiveSlot = true;
      const deleted: string[] = [];
      const { deps: d } = pruneDeps(
        [skill("doomed"), skill("bad"), skill("survivor")],
        {
          doomed: meta("assistant", "lastUsedAt", 45),
          bad: meta("assistant", "lastUsedAt", 45),
          survivor: meta("assistant", "lastUsedAt", 45),
        },
        30,
        {
          deleteSkill: async (id) => {
            if (id === "bad") throw new Error("delete boom");
            deleted.push(id);
          },
        },
      );
      const outcome = await maintainJob(JOB, CONFIG, d);

      // The failing delete did not abort the others.
      expect(deleted).toEqual(["doomed", "survivor"]);
      expect(outcome.prunedSkills).toEqual(["doomed", "survivor"]);
      expect(outcome.skillPruneFailures).toEqual([
        { skillId: "bad", error: "delete boom" },
      ]);
      // A contained per-skill failure is NOT a stage failure.
      expect(outcome.failures).not.toContain("skill-prune");
    });

    test("honors the threshold: a skill below skillPruneDays is kept", async () => {
      memoryV3LiveSlot = true;
      // 20 days old, threshold 30 ⇒ not deleted, and under the 30-day observe
      // window so not reported either.
      const { deps: d, deletedSkills } = pruneDeps(
        [skill("borderline")],
        { borderline: meta("assistant", "lastUsedAt", 20) },
        30,
      );
      const outcome = await maintainJob(JOB, CONFIG, d);

      expect(deletedSkills).toEqual([]);
      expect(outcome.prunedSkills).toEqual([]);
      expect(outcome.prunableSkills).toEqual([]);
    });
  });
});
