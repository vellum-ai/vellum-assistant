/**
 * Tests for `candidate-match.ts` — `nearestExistingSkills`, the skill-catalog
 * ANN shortlist.
 *
 * The matcher's ANN/embedding seam and its catalog read are dependency-injected
 * via `NearestExistingSkillsOptions`, so these tests exercise the pure ranking
 * with a fake scorer + fake catalog — no Qdrant, no embedding backend. Coverage:
 *   - Ranking: hits come back descending by score, each resolved from its
 *     capability-page slug to its skill id.
 *   - Top-K: the shortlist is bounded by `limit` (default 5).
 *   - Floor: hits below `SHORTLIST_THRESHOLD` are excluded; the floor is
 *     inclusive at the boundary.
 *   - Empty catalog → `[]` (the scorer is never called).
 *   - Default-scorer retry: a transient embedding failure is retried; a
 *     persistent transient error degrades to `[]` after the budget; a
 *     non-transient error degrades immediately without retry.
 *
 * The logger is stubbed so the default-scorer failure path stays quiet; the
 * ranking tests never reach it because they inject a fake scorer.
 */

import { describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../../../../__tests__/helpers/mock-logger.js";
import type { ScoredSlug } from "../candidate-match.js";

// Spread the real logger module so we override ONLY `getLogger`. The matcher's
// import graph transitively reaches CLI modules that import `getCliLogger` from
// this same module (candidate-match → config/skills → … → cli/program), so a
// mock that dropped `getCliLogger` would crash module evaluation with
// "export 'getCliLogger' not found in '../util/logger.js'".
const realLogger = await import("../../../../../util/logger.js");
mock.module("../../../../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => makeMockLogger(),
}));

// `simBatch` is the matcher's DEFAULT scorer (used only when the caller does not
// inject `scoreSlugs`). The retry tests below drive this default path, so the
// real `simBatch` is replaced by a programmable stub whose behavior each test
// sets via `simBatchImpl`. The ranking tests inject their own `scoreSlugs` and
// never touch this stub.
let simBatchImpl: (
  text: string,
  slugs: readonly string[],
) => Promise<Map<string, number>> = async () => new Map();
const realSim = await import("../../v2/sim.js");
mock.module("../../v2/sim.js", () => ({
  ...realSim,
  simBatch: (text: string, slugs: readonly string[]) =>
    simBatchImpl(text, slugs),
}));

// Make the retry backoff instant so the persistent-failure test does not wait
// out the real exponential delays.
const realRetry = await import("../../../../../util/retry.js");
mock.module("../../../../../util/retry.js", () => ({
  ...realRetry,
  abortableSleep: async () => {},
}));

const {
  nearestExistingSkills,
  EXISTING_SKILL_THRESHOLD,
  SHORTLIST_THRESHOLD,
  DEFAULT_SHORTLIST_LIMIT,
} = await import("../candidate-match.js");

// ---------------------------------------------------------------------------
// Test helpers — a fake scorer driven by a slug→score table, plus a fake
// catalog source. The scorer only returns hits for the slugs it was restricted
// to, mirroring `simBatch`'s server-side slug filter.
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

describe("nearestExistingSkills — ranking", () => {
  test("returns hits descending by score, each resolved to its skill id", async () => {
    const { fn } = fakeScorer({
      "skills/deploy-web": 0.91,
      "skills/rotate-secrets": 0.7,
      "skills/clean-disk": 0.83,
    });

    const result = await nearestExistingSkills("ship the web app to prod", {
      scoreSlugs: fn,
      loadCatalog: catalog("deploy-web", "rotate-secrets", "clean-disk"),
    });

    expect(result).toEqual([
      { skillId: "deploy-web", score: 0.91 },
      { skillId: "clean-disk", score: 0.83 },
      { skillId: "rotate-secrets", score: 0.7 },
    ]);
  });

  test("scores the capability-page slugs for the whole catalog", async () => {
    const { fn, calls } = fakeScorer({ "skills/a": 0.9 });

    await nearestExistingSkills("goal", {
      scoreSlugs: fn,
      loadCatalog: catalog("a", "b"),
    });

    expect(calls).toEqual([["skills/a", "skills/b"]]);
  });
});

describe("nearestExistingSkills — top-K bound", () => {
  test("caps the shortlist at the default limit", async () => {
    const scores: Record<string, number> = {};
    const ids: string[] = [];
    // Seven above-floor hits, strictly descending so order is deterministic.
    for (let i = 0; i < 7; i++) {
      const id = `skill-${i}`;
      ids.push(id);
      scores[`skills/${id}`] = 0.95 - i * 0.01;
    }
    const { fn } = fakeScorer(scores);

    const result = await nearestExistingSkills("goal", {
      scoreSlugs: fn,
      loadCatalog: catalog(...ids),
    });

    expect(result).toHaveLength(DEFAULT_SHORTLIST_LIMIT);
    // The highest-scoring five survive the cap.
    expect(result.map((h) => h.skillId)).toEqual([
      "skill-0",
      "skill-1",
      "skill-2",
      "skill-3",
      "skill-4",
    ]);
  });

  test("respects an explicit limit", async () => {
    const { fn } = fakeScorer({
      "skills/a": 0.9,
      "skills/b": 0.85,
      "skills/c": 0.8,
    });

    const result = await nearestExistingSkills("goal", {
      scoreSlugs: fn,
      loadCatalog: catalog("a", "b", "c"),
      limit: 2,
    });

    expect(result).toEqual([
      { skillId: "a", score: 0.9 },
      { skillId: "b", score: 0.85 },
    ]);
  });
});

describe("nearestExistingSkills — shortlist floor", () => {
  test("excludes hits below the floor", async () => {
    const { fn } = fakeScorer({
      "skills/keep": SHORTLIST_THRESHOLD + 0.05,
      "skills/drop": SHORTLIST_THRESHOLD - 0.01,
    });

    const result = await nearestExistingSkills("goal", {
      scoreSlugs: fn,
      loadCatalog: catalog("keep", "drop"),
    });

    expect(result).toEqual([
      { skillId: "keep", score: SHORTLIST_THRESHOLD + 0.05 },
    ]);
  });

  test("includes a hit exactly at the floor (inclusive)", async () => {
    const { fn } = fakeScorer({ "skills/edge": SHORTLIST_THRESHOLD });

    const result = await nearestExistingSkills("goal", {
      scoreSlugs: fn,
      loadCatalog: catalog("edge"),
    });

    expect(result).toEqual([{ skillId: "edge", score: SHORTLIST_THRESHOLD }]);
  });

  test("everything below the floor → empty shortlist", async () => {
    const { fn } = fakeScorer({
      "skills/a": SHORTLIST_THRESHOLD - 0.2,
      "skills/b": SHORTLIST_THRESHOLD - 0.01,
    });

    const result = await nearestExistingSkills("goal", {
      scoreSlugs: fn,
      loadCatalog: catalog("a", "b"),
    });

    expect(result).toEqual([]);
  });
});

describe("nearestExistingSkills — empty catalog", () => {
  test("empty catalog → [] without calling the scorer", async () => {
    const { fn, calls } = fakeScorer({});

    const result = await nearestExistingSkills("anything", {
      scoreSlugs: fn,
      loadCatalog: catalog(),
    });

    expect(result).toEqual([]);
    // No slugs to restrict to → scorer is never called (empty-set short-circuit).
    expect(calls).toEqual([]);
  });
});

describe("nearestExistingSkills — threshold sanity", () => {
  test("the shortlist floor sits below the confident same-skill mark", () => {
    expect(SHORTLIST_THRESHOLD).toBeLessThan(EXISTING_SKILL_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// Default-scorer retry. These tests do NOT inject `scoreSlugs`, so the matcher
// uses its real `scoreSlugsWithSimBatch` path, which calls the (stubbed)
// `simBatch`. `simBatch` embeds via `embedWithBackend` ONCE with no retry, so a
// transient provider blip would throw and degrade the shortlist to `[]` —
// silently hiding an existing skill. The matcher wraps `simBatch` in a bounded
// retry mirroring `embedWithRetry`'s policy and degrades to `[]` ONLY after the
// budget is exhausted.
// ---------------------------------------------------------------------------

// A 429 / 5xx-shaped transient error (recognized by `isTransientEmbeddingError`
// via its `status` field) versus a non-transient one (no status, non-matching
// message) that must NOT be retried.
const transientError = () =>
  Object.assign(new Error("rate limited"), { status: 429 });
const persistentError = () => new Error("qdrant collection not found");

// A config stub — the stubbed `simBatch` ignores it, but `nearestExistingSkills`
// reads `opts.config ?? getConfig()`, and passing one keeps the test off the
// real config loader.
const fakeConfig = {} as never;

describe("nearestExistingSkills — default scorer retries transient failures", () => {
  test("a transient error that succeeds on retry yields the hit, not []", async () => {
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

    const result = await nearestExistingSkills("ship the web app to prod", {
      config: fakeConfig,
      loadCatalog: catalog("deploy-web"),
    });

    expect(result).toEqual([{ skillId: "deploy-web", score: 0.95 }]);
    expect(calls).toBe(2);
  });

  test("a persistent transient error degrades to [] after the retry budget", async () => {
    let calls = 0;
    simBatchImpl = async () => {
      calls++;
      throw transientError();
    };

    const result = await nearestExistingSkills("ship the web app to prod", {
      config: fakeConfig,
      loadCatalog: catalog("deploy-web"),
    });

    expect(result).toEqual([]);
    // 1 initial attempt + EMBED_MAX_RETRIES (3) retries = 4 calls.
    expect(calls).toBe(4);
  });

  test("a non-transient error is NOT retried — degrades to [] immediately", async () => {
    let calls = 0;
    simBatchImpl = async () => {
      calls++;
      throw persistentError();
    };

    const result = await nearestExistingSkills("ship the web app to prod", {
      config: fakeConfig,
      loadCatalog: catalog("deploy-web"),
    });

    expect(result).toEqual([]);
    // No retry on a non-transient failure: exactly one attempt.
    expect(calls).toBe(1);
  });
});
