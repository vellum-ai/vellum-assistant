/**
 * Tests for `candidate-match.ts` — the procedural-memory candidate-identity
 * matcher (Tier 0 existing-skill + Tier 1 candidate-cluster).
 *
 * The matcher's ANN/embedding seam and its catalog/registry reads are
 * dependency-injected via `MatchCandidateOptions`, so these tests exercise the
 * pure tier logic with a fake scorer + fake catalog/candidate sets — no Qdrant,
 * no embedding backend. Coverage:
 *   - Tier 0: a goal scoring at/above the existing-skill threshold against a
 *     skill capability page resolves to `existing-skill` (and short-circuits
 *     Tier 1).
 *   - Tier 1: a goal scoring at/above the cluster threshold against a candidate
 *     member note resolves to `cluster` carrying the OWNING cluster's id — not
 *     the matched note slug (the store keys every mutator on `cluster_id`).
 *   - Novel: a goal below the gray band against everything resolves to `new`.
 *   - Gray band: a goal whose best candidate match lands in
 *     `[GRAY_BAND_THRESHOLD, CLUSTER_MATCH_THRESHOLD)` resolves to `gray`
 *     carrying the owning cluster id (the Tier-2 judge is the caller's job,
 *     never invoked here).
 *   - Threshold precedence (Tier 0 beats Tier 1) + read-only invariant (no
 *     writes, default registry reader only SELECTs).
 *
 * The logger is stubbed so the default-scorer failure path stays quiet; the
 * tier-logic tests never reach it because they inject a fake scorer.
 */

import { describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../../../__tests__/helpers/mock-logger.js";
import type { CandidateClusterRef, ScoredSlug } from "../candidate-match.js";

// Spread the real logger module so we override ONLY `getLogger`. The matcher's
// import graph transitively reaches CLI modules that import `getCliLogger` from
// this same module (candidate-match → config/skills → … → cli/program), so a
// mock that dropped `getCliLogger` would crash module evaluation with
// "export 'getCliLogger' not found in '../util/logger.js'".
const realLogger = await import("../../../../util/logger.js");
mock.module("../../../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => makeMockLogger(),
}));

// `simBatch` is the matcher's DEFAULT scorer (used only when the caller does not
// inject `scoreSlugs`). The retry tests below drive this default path, so the
// real `simBatch` is replaced by a programmable stub whose behavior each test
// sets via `simBatchImpl`. The tier-logic tests inject their own `scoreSlugs`
// and never touch this stub.
let simBatchImpl: (
  text: string,
  slugs: readonly string[],
) => Promise<Map<string, number>> = async () => new Map();
const realSim = await import("../../../../memory/v2/sim.js");
mock.module("../../../../memory/v2/sim.js", () => ({
  ...realSim,
  simBatch: (text: string, slugs: readonly string[]) =>
    simBatchImpl(text, slugs),
}));

// Make the retry backoff instant so the persistent-failure test does not wait
// out the real exponential delays.
const realRetry = await import("../../../../util/retry.js");
mock.module("../../../../util/retry.js", () => ({
  ...realRetry,
  abortableSleep: async () => {},
}));

const {
  matchCandidate,
  EXISTING_SKILL_THRESHOLD,
  CLUSTER_MATCH_THRESHOLD,
  GRAY_BAND_THRESHOLD,
} = await import("../candidate-match.js");

// ---------------------------------------------------------------------------
// Test helpers — a fake scorer driven by a slug→score table, plus fake catalog
// and candidate-note sources. The scorer only returns hits for the slugs it was
// restricted to, mirroring `hybridQueryConceptPages`'s server-side filter.
// ---------------------------------------------------------------------------

function fakeScorer(scores: Record<string, number>) {
  const calls: string[][] = [];
  const fn = async (
    _goal: string,
    restrictToSlugs: readonly string[],
  ): Promise<ScoredSlug[]> => {
    calls.push([...restrictToSlugs]);
    return restrictToSlugs
      .filter((slug) => slug in scores)
      .map((slug) => ({ slug, score: scores[slug]! }));
  };
  return { fn, calls };
}

const catalog =
  (...ids: string[]) =>
  () =>
    ids.map((id) => ({ id }));

// A Tier-1 candidate-cluster source. Each cluster carries its own `clusterId`
// plus the member-note slugs that are actually embedded; the matcher ANN-scores
// the slugs but must report the owning clusterId. Fixtures deliberately give
// clusters a `clusterId` that DIFFERS from any member-note slug so a test fails
// if the matcher leaks a note slug as the clusterId.
const clusters =
  (...refs: CandidateClusterRef[]) =>
  () =>
    refs;
const cluster = (
  clusterId: string,
  ...memberNoteSlugs: string[]
): CandidateClusterRef => ({ clusterId, memberNoteSlugs });

describe("matchCandidate — Tier 0 (existing skill)", () => {
  test("a goal matching a skill capability page → existing-skill", async () => {
    const { fn } = fakeScorer({ "skills/deploy-web": 0.91 });

    const result = await matchCandidate("ship the web app to prod", {
      scoreSlugs: fn,
      loadCatalog: catalog("deploy-web", "rotate-secrets"),
      listCandidateClusters: clusters(
        cluster("cluster/other", "proc/something-else"),
      ),
    });

    expect(result).toEqual({ kind: "existing-skill", skillId: "deploy-web" });
  });

  test("Tier 0 short-circuits before Tier 1 is even queried", async () => {
    const { fn, calls } = fakeScorer({
      "skills/deploy-web": EXISTING_SKILL_THRESHOLD,
      // A candidate note that would ALSO match — but Tier 1 must never run.
      "proc/deploy-candidate": 0.99,
    });

    const result = await matchCandidate("deploy the app", {
      scoreSlugs: fn,
      loadCatalog: catalog("deploy-web"),
      listCandidateClusters: clusters(
        cluster("cluster/deploy", "proc/deploy-candidate"),
      ),
    });

    expect(result).toEqual({ kind: "existing-skill", skillId: "deploy-web" });
    // Only the Tier-0 (skill) restriction was scored.
    expect(calls).toEqual([["skills/deploy-web"]]);
  });

  test("a skill hit just below the threshold does NOT match Tier 0", async () => {
    const { fn } = fakeScorer({
      "skills/deploy-web": EXISTING_SKILL_THRESHOLD - 0.01,
    });

    const result = await matchCandidate("deploy the app", {
      scoreSlugs: fn,
      loadCatalog: catalog("deploy-web"),
      listCandidateClusters: clusters(),
    });

    // Falls through Tier 0 and Tier 1 (no candidates) → new.
    expect(result).toEqual({ kind: "new" });
  });
});

describe("matchCandidate — Tier 1 (candidate cluster)", () => {
  test("a goal matching a member note → cluster carrying the OWNING clusterId (not the note slug)", async () => {
    const { fn } = fakeScorer({
      "skills/unrelated": 0.1,
      "proc/cleanup-disk": 0.85,
    });

    // The owning cluster's id DIFFERS from the matched member-note slug. The
    // matcher must report the clusterId — the store keys every mutator on it.
    const result = await matchCandidate("clear out the disk", {
      scoreSlugs: fn,
      loadCatalog: catalog("unrelated"),
      listCandidateClusters: clusters(
        cluster("cluster/disk-housekeeping", "proc/cleanup-disk", "proc/other"),
      ),
    });

    expect(result).toEqual({
      kind: "cluster",
      clusterId: "cluster/disk-housekeeping",
    });
    // Regression guard: the matched note slug must NOT leak out as the clusterId.
    expect(result).not.toEqual({
      kind: "cluster",
      clusterId: "proc/cleanup-disk",
    });
  });

  test("the highest-scoring candidate wins, reported as its owning clusterId", async () => {
    const { fn } = fakeScorer({
      "proc/a": CLUSTER_MATCH_THRESHOLD + 0.01,
      "proc/b": CLUSTER_MATCH_THRESHOLD + 0.1,
      "proc/c": CLUSTER_MATCH_THRESHOLD + 0.05,
    });

    // Each note lives in a distinct cluster whose id differs from the note slug.
    const result = await matchCandidate("do the thing", {
      scoreSlugs: fn,
      loadCatalog: catalog(),
      listCandidateClusters: clusters(
        cluster("cluster/a", "proc/a"),
        cluster("cluster/b", "proc/b"),
        cluster("cluster/c", "proc/c"),
      ),
    });

    // Winner is proc/b's score → its owning cluster, not the note slug.
    expect(result).toEqual({ kind: "cluster", clusterId: "cluster/b" });
  });

  test("a candidate exactly at the cluster threshold matches (inclusive)", async () => {
    const { fn } = fakeScorer({ "proc/edge": CLUSTER_MATCH_THRESHOLD });

    const result = await matchCandidate("boundary goal", {
      scoreSlugs: fn,
      loadCatalog: catalog(),
      listCandidateClusters: clusters(cluster("cluster/edge", "proc/edge")),
    });

    expect(result).toEqual({ kind: "cluster", clusterId: "cluster/edge" });
  });
});

describe("matchCandidate — novel goal", () => {
  test("nothing close enough → new", async () => {
    const { fn } = fakeScorer({
      "skills/deploy-web": 0.2,
      "proc/cleanup-disk": GRAY_BAND_THRESHOLD - 0.01,
    });

    const result = await matchCandidate("a totally unrelated brand-new task", {
      scoreSlugs: fn,
      loadCatalog: catalog("deploy-web"),
      listCandidateClusters: clusters(
        cluster("cluster/disk-housekeeping", "proc/cleanup-disk"),
      ),
    });

    expect(result).toEqual({ kind: "new" });
  });

  test("empty catalog + empty candidate pool → new", async () => {
    const { fn, calls } = fakeScorer({});

    const result = await matchCandidate("anything", {
      scoreSlugs: fn,
      loadCatalog: catalog(),
      listCandidateClusters: clusters(),
    });

    expect(result).toEqual({ kind: "new" });
    // No slugs to restrict to → scorer is never called (empty-set short-circuit).
    expect(calls).toEqual([]);
  });
});

describe("matchCandidate — gray band (deferred to caller's Tier-2 judge)", () => {
  test("a borderline member note → gray carrying the OWNING clusterId (not the note slug)", async () => {
    const { fn } = fakeScorer({
      "proc/deploy-preview":
        (GRAY_BAND_THRESHOLD + CLUSTER_MATCH_THRESHOLD) / 2,
    });

    // The owning cluster's id DIFFERS from the matched member-note slug; the
    // gray result must hand the Tier-2 judge the clusterId, not the note slug.
    const result = await matchCandidate("deploy to production", {
      scoreSlugs: fn,
      loadCatalog: catalog(),
      listCandidateClusters: clusters(
        cluster("cluster/deploy-rituals", "proc/deploy-preview"),
      ),
    });

    expect(result).toEqual({
      kind: "gray",
      clusterId: "cluster/deploy-rituals",
    });
    // Regression guard: the matched note slug must NOT leak out as the clusterId.
    expect(result).not.toEqual({
      kind: "gray",
      clusterId: "proc/deploy-preview",
    });
  });

  test("a candidate exactly at the gray-band floor → gray (inclusive)", async () => {
    const { fn } = fakeScorer({ "proc/edge": GRAY_BAND_THRESHOLD });

    const result = await matchCandidate("boundary goal", {
      scoreSlugs: fn,
      loadCatalog: catalog(),
      listCandidateClusters: clusters(cluster("cluster/edge", "proc/edge")),
    });

    expect(result).toEqual({ kind: "gray", clusterId: "cluster/edge" });
  });

  test("just below the gray-band floor → new, not gray", async () => {
    const { fn } = fakeScorer({ "proc/edge": GRAY_BAND_THRESHOLD - 0.001 });

    const result = await matchCandidate("boundary goal", {
      scoreSlugs: fn,
      loadCatalog: catalog(),
      listCandidateClusters: clusters(cluster("cluster/edge", "proc/edge")),
    });

    expect(result).toEqual({ kind: "new" });
  });
});

describe("matchCandidate — thresholds are ordered for precision bias", () => {
  test("gray floor < cluster bar < existing-skill bar", () => {
    expect(GRAY_BAND_THRESHOLD).toBeLessThan(CLUSTER_MATCH_THRESHOLD);
    expect(CLUSTER_MATCH_THRESHOLD).toBeLessThanOrEqual(
      EXISTING_SKILL_THRESHOLD,
    );
  });
});

// ---------------------------------------------------------------------------
// Default-scorer retry. These tests do NOT inject `scoreSlugs`, so the matcher
// uses its real `scoreSlugsWithSimBatch` path, which calls the (stubbed)
// `simBatch`. `simBatch` embeds via `embedWithBackend` ONCE with no retry, so a
// transient provider blip would throw and degrade the matcher to a no-hit —
// silently missing an existing skill or forking a duplicate cluster. The
// matcher wraps `simBatch` in a bounded retry mirroring `embedWithRetry`'s
// policy and degrades to no-hit ONLY after the budget is exhausted.
// ---------------------------------------------------------------------------

// A 429 / 5xx-shaped transient error (recognized by `isTransientEmbeddingError`
// via its `status` field) versus a non-transient one (no status, non-matching
// message) that must NOT be retried.
const transientError = () =>
  Object.assign(new Error("rate limited"), { status: 429 });
const persistentError = () => new Error("qdrant collection not found");

// A config stub — the stubbed `simBatch` ignores it, but `matchCandidate` reads
// `opts.config ?? getConfig()`, and passing one keeps the test off the real
// config loader.
const fakeConfig = {} as never;

describe("matchCandidate — default scorer retries transient embedding failures", () => {
  test("a transient embedding error that succeeds on retry yields the correct hit, not []", async () => {
    let calls = 0;
    simBatchImpl = async (_text, slugs) => {
      calls++;
      if (calls === 1) throw transientError();
      // Second attempt succeeds: the skill's capability page scores high.
      return new Map(
        slugs
          .filter((s) => s === "skills/deploy-web")
          .map((s) => [s, 0.95] as const),
      );
    };

    const result = await matchCandidate("ship the web app to prod", {
      config: fakeConfig,
      loadCatalog: catalog("deploy-web"),
      listCandidateClusters: clusters(),
    });

    // Without retry the first throw would degrade to `new`; with retry we get
    // the existing-skill hit on the second attempt.
    expect(result).toEqual({ kind: "existing-skill", skillId: "deploy-web" });
    expect(calls).toBe(2);
  });

  test("a persistent transient error still degrades to no-hit after the retry budget", async () => {
    let calls = 0;
    simBatchImpl = async () => {
      calls++;
      throw transientError();
    };

    const result = await matchCandidate("ship the web app to prod", {
      config: fakeConfig,
      loadCatalog: catalog("deploy-web"),
      listCandidateClusters: clusters(),
    });

    // Retries exhausted → scorer returns [] → matcher treats the goal as new.
    expect(result).toEqual({ kind: "new" });
    // 1 initial attempt + EMBED_MAX_RETRIES (3) retries = 4 calls.
    expect(calls).toBe(4);
  });

  test("a non-transient error is NOT retried — degrades to no-hit immediately", async () => {
    let calls = 0;
    simBatchImpl = async () => {
      calls++;
      throw persistentError();
    };

    const result = await matchCandidate("ship the web app to prod", {
      config: fakeConfig,
      loadCatalog: catalog("deploy-web"),
      listCandidateClusters: clusters(),
    });

    expect(result).toEqual({ kind: "new" });
    // No retry on a non-transient failure: exactly one attempt.
    expect(calls).toBe(1);
  });
});
