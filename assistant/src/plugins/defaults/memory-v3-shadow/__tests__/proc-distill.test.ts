/**
 * Tests for the DISTILLATION phase of `proc-distill-trigger.ts` (PR 9).
 *
 * The tally phase (open / join / judge / mark-ready) is covered by
 * `proc-distill-trigger.test.ts`. This file isolates the second phase: turning
 * a `ready` cluster into a managed skill and retiring its candidate notes.
 * Every collaborator is dependency-injected, so the `distill` launcher (which
 * in production drives a guardian background agent run via `runBackgroundJob`)
 * and the note reader/deleter are in-memory fakes — no agent, no Qdrant, no DB.
 *
 * Coverage:
 *   - a `ready` cluster → ONE distill call with a coherent input (the right
 *     skill id, goal, and member-note bodies), candidate notes deleted, cluster
 *     marked `distilled`;
 *   - an `observing` cluster is never distilled (not in the ready queue);
 *   - a distillation FAILURE leaves the cluster `ready` and does NOT delete the
 *     notes (safe retry).
 *
 * The logger is stubbed so best-effort warn paths stay quiet.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";

import { makeMockLogger } from "../../../../__tests__/helpers/mock-logger.js";
import type { AssistantConfig } from "../../../../config/types.js";
import type { MemoryJob } from "../../../../memory/jobs-store.js";
import type { CandidateClusterRef } from "../candidate-match.js";
import type { ProcCandidate } from "../proc-candidate-store.js";

// Spread the real logger module and override only `getLogger`: the distillation
// launcher transitively imports the background-job runner, whose import graph
// reads other logger exports (e.g. `truncateForLog`), so a wholesale replacement
// of just `getLogger` would strip symbols the chain needs.
const realLogger = await import("../../../../util/logger.js");
mock.module("../../../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => makeMockLogger(),
}));

// The job gates on `isProcToSkillsActive` (flag on AND v3 live); this slot
// drives the active predicate so the disabled-path test can flip it off.
let procToSkillsActiveSlot = true;
// Replace the whole gate module (mock.module is process-global). The
// distillation launcher transitively imports the background-job runner, whose
// import graph pulls these gate exports, so all three must be present.
mock.module("../../../../config/memory-v3-gate.js", () => ({
  isProcToSkillsActive: () => procToSkillsActiveSlot,
  isProcToSkillsEnabled: () => procToSkillsActiveSlot,
  isMemoryV3Live: () => true,
}));

const { procDistillTriggerJob, skillIdForGoal } =
  await import("../proc-distill-trigger.js");
import type {
  DistillRunInput,
  DistillRunResult,
  ProcDistillTriggerDeps,
} from "../proc-distill-trigger.js";

const JOB = {
  id: "job-1",
  type: "memory_proc_distill",
} as unknown as MemoryJob;

afterEach(() => {
  procToSkillsActiveSlot = true;
});

function config(minRecurrence = 2): AssistantConfig {
  return {
    memory: { procToSkills: { minRecurrence } },
  } as unknown as AssistantConfig;
}

// In-memory candidate registry seeded directly with clusters in a chosen status
// so the distillation phase has work without driving the tally phase.
function fakeRegistry(seed: ProcCandidate[]) {
  const rows = new Map<string, ProcCandidate>();
  for (const c of seed) rows.set(c.clusterId, { ...c });
  return {
    rows,
    getCandidate: (id: string) => rows.get(id) ?? null,
    markCandidateStatus: (id: string, status: ProcCandidate["status"]) => {
      const row = rows.get(id);
      if (row) row.status = status;
    },
    listReadyClusters: (): ProcCandidate[] =>
      [...rows.values()].filter((r) => r.status === "ready"),
    listClusters: (): CandidateClusterRef[] =>
      [...rows.values()]
        .filter((r) => r.status === "observing" || r.status === "ready")
        .map((r) => ({
          clusterId: r.clusterId,
          memberNoteSlugs: r.memberNoteSlugs,
        })),
    // Idempotency skip-set source (observing + ready + distilled). Unused here —
    // these distillation tests don't run the tally phase — but required by the
    // deps shape, so mirror the full-membership projection.
    listAssignedClusters: (): CandidateClusterRef[] =>
      [...rows.values()]
        .filter(
          (r) =>
            r.status === "observing" ||
            r.status === "ready" ||
            r.status === "distilled",
        )
        .map((r) => ({
          clusterId: r.clusterId,
          memberNoteSlugs: r.memberNoteSlugs,
        })),
  };
}

function cluster(
  over: Partial<ProcCandidate> & { clusterId: string },
): ProcCandidate {
  return {
    goal: "deploy the web app",
    memberNoteSlugs: [],
    count: 2,
    status: "ready",
    explicit: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

interface HarnessOpts {
  seed: ProcCandidate[];
  noteBodies?: Record<string, string>;
  distillResult?: DistillRunResult;
  /**
   * Skill ids the (fake) catalog reports as already existing BEFORE any run —
   * the pre-existing / colliding-skill scenario. Defaults to empty (a fresh
   * catalog).
   */
  preExistingSkillIds?: string[];
  /**
   * Whether a successful, non-skipped `distill` run scaffolds its skill into the
   * catalog (the realistic default). The fake catalog starts from
   * `preExistingSkillIds` and the run ADDS its id — so `skillExists` returns
   * `false` before the run and `true` after, exactly as production does. Set
   * `false` to model a turn that finished without scaffolding (the skill is
   * absent afterward).
   */
  scaffoldOnDistill?: boolean;
}

function harness(opts: HarnessOpts) {
  const reg = fakeRegistry(opts.seed);
  const bodies = opts.noteBodies ?? {};
  const distillCalls: DistillRunInput[] = [];
  const deletedSlugs: string[] = [];
  const cleanedSlugs: string[] = [];
  // A MUTABLE fake catalog: seeded with any pre-existing ids, then grown by a
  // successful scaffolding run. This models the real catalog so `skillExists`
  // distinguishes "existed before the run" (collision) from "created by this
  // run" (genuine distillation) — the distinction Fix ③ turns on.
  const catalog = new Set(opts.preExistingSkillIds ?? []);
  const scaffoldOnDistill = opts.scaffoldOnDistill ?? true;
  const distillResult = opts.distillResult ?? { ok: true };

  const deps: ProcDistillTriggerDeps = {
    config: config(),
    // Tally phase finds nothing — these tests start from pre-seeded clusters.
    loadCandidateNotes: async () => [],
    listClusters: reg.listClusters,
    listAssignedClusters: reg.listAssignedClusters,
    matchCandidate: async () => ({ kind: "new" }),
    judge: async () => false,
    upsertCandidate: () => {},
    incrementCandidate: () => {},
    setCandidateExplicit: () => {},
    addMemberNote: () => {},
    getCandidate: reg.getCandidate,
    markCandidateStatus: reg.markCandidateStatus,
    listReadyClusters: reg.listReadyClusters,
    loadClusterNotes: async (slugs) =>
      slugs
        .filter((s) => s in bodies)
        .map((s) => ({ slug: s, body: bodies[s] })),
    distill: async (input) => {
      distillCalls.push(input);
      // A successful, non-skipped run scaffolds its skill into the catalog —
      // mirroring `scaffold_managed_skill` so the post-run `skillExists` passes.
      if (scaffoldOnDistill && distillResult.ok && !distillResult.skipReason) {
        catalog.add(input.skillId);
      }
      return distillResult;
    },
    skillExists: (skillId) => catalog.has(skillId),
    deleteNote: async (slug) => {
      deletedSlugs.push(slug);
    },
    enqueueVectorCleanup: (slug) => {
      cleanedSlugs.push(slug);
    },
  };
  return { reg, deps, distillCalls, deletedSlugs, cleanedSlugs };
}

describe("skillIdForGoal", () => {
  test("derives a stable, valid slug from the goal with a disambiguator", () => {
    const id = skillIdForGoal("Deploy the Web App");
    // The human-readable head is the goal slug; a short hex disambiguator is
    // appended so distinct clusters with the same goal slug can't collide.
    expect(id).toMatch(/^deploy-the-web-app-[0-9a-f]{8}$/);
    // Deterministic for a given goal (immutable link target).
    expect(skillIdForGoal("Deploy the Web App")).toBe(
      skillIdForGoal("Deploy the Web App"),
    );
  });

  test("is deterministic for a given (goal, seed)", () => {
    expect(skillIdForGoal("deploy the web app", "cluster/proc/a")).toBe(
      skillIdForGoal("deploy the web app", "cluster/proc/a"),
    );
  });

  test("distinct seeds yield distinct ids even for the same goal slug", () => {
    // Two distinct clusters whose goals slugify identically must NOT collide on
    // the skill id — the data-loss hazard Fix ③ closes.
    const a = skillIdForGoal("deploy the web app", "cluster/proc/a");
    const b = skillIdForGoal("deploy the web app", "cluster/proc/b");
    expect(a).not.toBe(b);
    // Both still share the readable head.
    expect(a).toMatch(/^deploy-the-web-app-[0-9a-f]{8}$/);
    expect(b).toMatch(/^deploy-the-web-app-[0-9a-f]{8}$/);
  });

  test("strips punctuation and collapses separators in the head", () => {
    expect(skillIdForGoal("  rotate: the *signing* secrets!  ")).toMatch(
      /^rotate-the-signing-secrets-[0-9a-f]{8}$/,
    );
  });

  test("returns null when the goal has no alphanumeric content", () => {
    expect(skillIdForGoal("!!!")).toBeNull();
    expect(skillIdForGoal("   ")).toBeNull();
  });
});

describe("procDistillTriggerJob — distillation", () => {
  test("a verified skill creation → notes deleted and cluster marked distilled", async () => {
    // The id is keyed on (goal, clusterId), so compute the expected value the
    // same way production does rather than hardcoding the disambiguator.
    const expectedId = skillIdForGoal(
      "deploy the web app",
      "cluster/proc/deploy-1",
    )!;
    const { reg, deps, distillCalls, deletedSlugs, cleanedSlugs } = harness({
      seed: [
        cluster({
          clusterId: "cluster/proc/deploy-1",
          goal: "deploy the web app",
          memberNoteSlugs: ["proc/deploy-1", "proc/deploy-2"],
        }),
      ],
      noteBodies: {
        "proc/deploy-1": "ran build, then pushed to prod via the CLI",
        "proc/deploy-2": "rebuilt, retried once, pushed to prod via the CLI",
      },
      // Default: the run scaffolds its skill into the (initially empty) catalog,
      // so `skillExists` is false before the run and true after — a genuine
      // this-run creation, not a pre-existing collision.
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    // Exactly one scaffold launch, with the stable id + both trace bodies.
    expect(distillCalls).toHaveLength(1);
    expect(distillCalls[0].skillId).toBe(expectedId);
    expect(distillCalls[0].goal).toBe("deploy the web app");
    expect(distillCalls[0].notes.map((n) => n.slug)).toEqual([
      "proc/deploy-1",
      "proc/deploy-2",
    ]);
    expect(distillCalls[0].notes[0].body).toContain("pushed to prod");

    // Notes retired, cluster marked distilled.
    expect(deletedSlugs).toEqual(["proc/deploy-1", "proc/deploy-2"]);
    // Fix ②: each deleted slug gets vector cleanup enqueued promptly.
    expect(cleanedSlugs).toEqual(["proc/deploy-1", "proc/deploy-2"]);
    expect(reg.rows.get("cluster/proc/deploy-1")!.status).toBe("distilled");
    expect(outcome.distilled).toEqual(["cluster/proc/deploy-1"]);
    expect(outcome.distillFailures).toBe(0);
  });

  test("an observing cluster is never distilled", async () => {
    const { reg, deps, distillCalls, deletedSlugs } = harness({
      seed: [
        cluster({
          clusterId: "cluster/proc/draft",
          status: "observing",
          memberNoteSlugs: ["proc/draft"],
        }),
      ],
      noteBodies: { "proc/draft": "did the thing once" },
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    expect(distillCalls).toHaveLength(0);
    expect(deletedSlugs).toEqual([]);
    expect(reg.rows.get("cluster/proc/draft")!.status).toBe("observing");
    expect(outcome.distilled).toEqual([]);
  });

  test("a distillation failure leaves the cluster ready and keeps its notes", async () => {
    const { reg, deps, distillCalls, deletedSlugs } = harness({
      seed: [
        cluster({
          clusterId: "cluster/proc/deploy-1",
          memberNoteSlugs: ["proc/deploy-1", "proc/deploy-2"],
        }),
      ],
      noteBodies: {
        "proc/deploy-1": "trace one",
        "proc/deploy-2": "trace two",
      },
      distillResult: { ok: false },
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    // The run was attempted, but nothing was retired and the cluster is still
    // ready — the next pass can safely retry.
    expect(distillCalls).toHaveLength(1);
    expect(deletedSlugs).toEqual([]);
    expect(reg.rows.get("cluster/proc/deploy-1")!.status).toBe("ready");
    expect(outcome.distilled).toEqual([]);
    expect(outcome.distillFailures).toBe(1);
  });

  test("a skipped run (skipReason) is NOT distilled; cluster stays ready, notes intact", async () => {
    const { reg, deps, distillCalls, deletedSlugs } = harness({
      seed: [
        cluster({
          clusterId: "cluster/proc/deploy-1",
          goal: "deploy the web app",
          memberNoteSlugs: ["proc/deploy-1", "proc/deploy-2"],
        }),
      ],
      noteBodies: {
        "proc/deploy-1": "trace one",
        "proc/deploy-2": "trace two",
      },
      // The pre-first-message gate tripped: the runner returns ok:true but ran
      // no conversation, so it scaffolds nothing. A skip never distills — the
      // notes must be preserved. No pre-existing collision, so the pass reaches
      // the distill call and the skip path is what preserves the notes.
      distillResult: { ok: true, skipReason: "pre_first_user_message" },
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    // The run was attempted but skipped — nothing retired, cluster still ready.
    expect(distillCalls).toHaveLength(1);
    expect(deletedSlugs).toEqual([]);
    expect(reg.rows.get("cluster/proc/deploy-1")!.status).toBe("ready");
    expect(outcome.distilled).toEqual([]);
    expect(outcome.distillFailures).toBe(1);
  });

  test("a run that finishes but the skill does not exist → stays ready, notes intact", async () => {
    const { reg, deps, distillCalls, deletedSlugs } = harness({
      seed: [
        cluster({
          clusterId: "cluster/proc/deploy-1",
          goal: "deploy the web app",
          memberNoteSlugs: ["proc/deploy-1", "proc/deploy-2"],
        }),
      ],
      noteBodies: {
        "proc/deploy-1": "trace one",
        "proc/deploy-2": "trace two",
      },
      // The turn completed (ok:true, no skip) but never scaffolded the skill —
      // the catalog has nothing for this id afterward.
      distillResult: { ok: true },
      scaffoldOnDistill: false,
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    // Skill was never created → the captured procedure must be preserved.
    expect(distillCalls).toHaveLength(1);
    expect(deletedSlugs).toEqual([]);
    expect(reg.rows.get("cluster/proc/deploy-1")!.status).toBe("ready");
    expect(outcome.distilled).toEqual([]);
    expect(outcome.distillFailures).toBe(1);
  });

  test("Fix ③: a skill id that already exists BEFORE the run is a collision → notes NOT deleted, stays ready", async () => {
    // The data-loss path: a DISTINCT skill already owns this cluster's id (a
    // colliding cluster, or a pre-existing skill). The distill run's scaffold
    // would fail on the duplicate id, yet a naive `skillExists` check afterward
    // would still pass (the OTHER skill exists) and retire THIS cluster's notes.
    // The `existedBefore` guard rejects the cluster before it ever runs.
    const expectedId = skillIdForGoal(
      "deploy the web app",
      "cluster/proc/deploy-1",
    )!;
    const { reg, deps, distillCalls, deletedSlugs, cleanedSlugs } = harness({
      seed: [
        cluster({
          clusterId: "cluster/proc/deploy-1",
          goal: "deploy the web app",
          memberNoteSlugs: ["proc/deploy-1", "proc/deploy-2"],
        }),
      ],
      noteBodies: {
        "proc/deploy-1": "trace one",
        "proc/deploy-2": "trace two",
      },
      // The id is ALREADY taken before this cluster runs (collision).
      preExistingSkillIds: [expectedId],
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    // A collision is rejected before launching: no distill run, no deletes, no
    // vector cleanup, and the cluster stays `ready` so its notes survive.
    expect(distillCalls).toHaveLength(0);
    expect(deletedSlugs).toEqual([]);
    expect(cleanedSlugs).toEqual([]);
    expect(reg.rows.get("cluster/proc/deploy-1")!.status).toBe("ready");
    expect(outcome.distilled).toEqual([]);
    expect(outcome.distillFailures).toBe(1);
  });

  test("two distinct clusters with the same goal get distinct skill ids (no collision)", async () => {
    // Same goal, two distinct cluster ids → two distinct skill ids, so both
    // distill independently with neither's id pre-existing for the other.
    const idA = skillIdForGoal("deploy the web app", "cluster/proc/a")!;
    const idB = skillIdForGoal("deploy the web app", "cluster/proc/b")!;
    expect(idA).not.toBe(idB);

    const { reg, deps, distillCalls, deletedSlugs } = harness({
      seed: [
        cluster({
          clusterId: "cluster/proc/a",
          goal: "deploy the web app",
          memberNoteSlugs: ["proc/a"],
        }),
        cluster({
          clusterId: "cluster/proc/b",
          goal: "deploy the web app",
          memberNoteSlugs: ["proc/b"],
        }),
      ],
      noteBodies: { "proc/a": "trace a", "proc/b": "trace b" },
      // Each run scaffolds its own distinct id into the catalog; because the ids
      // differ, neither pre-exists when the other runs (no spurious collision).
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    // Both clusters distill — distinct ids mean no spurious collision rejection.
    expect(distillCalls.map((c) => c.skillId).sort()).toEqual(
      [idA, idB].sort(),
    );
    expect(deletedSlugs.sort()).toEqual(["proc/a", "proc/b"]);
    expect(reg.rows.get("cluster/proc/a")!.status).toBe("distilled");
    expect(reg.rows.get("cluster/proc/b")!.status).toBe("distilled");
    expect(outcome.distilled.sort()).toEqual(
      ["cluster/proc/a", "cluster/proc/b"].sort(),
    );
  });

  test("a ready cluster with no readable notes is left ready (nothing to distill)", async () => {
    const { reg, deps, distillCalls, deletedSlugs } = harness({
      seed: [
        cluster({
          clusterId: "cluster/proc/gone",
          memberNoteSlugs: ["proc/gone"],
        }),
      ],
      // No body registered → loadClusterNotes returns [].
      noteBodies: {},
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    expect(distillCalls).toHaveLength(0);
    expect(deletedSlugs).toEqual([]);
    expect(reg.rows.get("cluster/proc/gone")!.status).toBe("ready");
    expect(outcome.distillFailures).toBe(1);
  });

  test("inactive (flag off / v3 not live) → distillation phase no-ops", async () => {
    procToSkillsActiveSlot = false;
    const { reg, deps, distillCalls } = harness({
      seed: [
        cluster({
          clusterId: "cluster/proc/deploy-1",
          memberNoteSlugs: ["proc/deploy-1"],
        }),
      ],
      noteBodies: { "proc/deploy-1": "trace" },
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    expect(outcome.disabled).toBe(true);
    expect(distillCalls).toHaveLength(0);
    expect(reg.rows.get("cluster/proc/deploy-1")!.status).toBe("ready");
  });
});
