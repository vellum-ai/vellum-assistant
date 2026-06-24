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

mock.module("../../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
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
