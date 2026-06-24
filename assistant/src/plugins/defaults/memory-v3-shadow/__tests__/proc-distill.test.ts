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
      [...rows.values()].map((r) => ({
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
   * Skill ids the (fake) catalog reports as existing AFTER the distill run. The
   * production check is `loadSkillCatalog().some(...)`; here it is a fixed set.
   * Defaults to "every requested skill id exists" so a plain successful run
   * verifies — tests exercising the no-skill path pass an explicit `[]`.
   */
  existingSkillIds?: string[];
}

function harness(opts: HarnessOpts) {
  const reg = fakeRegistry(opts.seed);
  const bodies = opts.noteBodies ?? {};
  const distillCalls: DistillRunInput[] = [];
  const deletedSlugs: string[] = [];
  // `undefined` → the skill always verifies (default happy path). An explicit
  // array → only those ids verify (used to simulate a run that scaffolded
  // nothing, where the target skill is absent afterward).
  const existingSkillIds = opts.existingSkillIds;

  const deps: ProcDistillTriggerDeps = {
    config: config(),
    // Tally phase finds nothing — these tests start from pre-seeded clusters.
    loadCandidateNotes: async () => [],
    listClusters: reg.listClusters,
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
      return opts.distillResult ?? { ok: true };
    },
    skillExists: (skillId) =>
      existingSkillIds === undefined
        ? true
        : existingSkillIds.includes(skillId),
    deleteNote: async (slug) => {
      deletedSlugs.push(slug);
    },
  };
  return { reg, deps, distillCalls, deletedSlugs };
}

describe("skillIdForGoal", () => {
  test("derives a stable, valid slug from the goal", () => {
    expect(skillIdForGoal("Deploy the Web App")).toBe("deploy-the-web-app");
    // Deterministic for a given goal (immutable link target).
    expect(skillIdForGoal("Deploy the Web App")).toBe(
      skillIdForGoal("Deploy the Web App"),
    );
  });

  test("strips punctuation and collapses separators", () => {
    expect(skillIdForGoal("  rotate: the *signing* secrets!  ")).toBe(
      "rotate-the-signing-secrets",
    );
  });

  test("returns null when the goal has no alphanumeric content", () => {
    expect(skillIdForGoal("!!!")).toBeNull();
    expect(skillIdForGoal("   ")).toBeNull();
  });
});

describe("procDistillTriggerJob — distillation", () => {
  test("a verified skill creation → notes deleted and cluster marked distilled", async () => {
    const { reg, deps, distillCalls, deletedSlugs } = harness({
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
      // The run actually scaffolded the skill — it now appears in the catalog.
      existingSkillIds: ["deploy-the-web-app"],
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    // Exactly one scaffold launch, with the stable id + both trace bodies.
    expect(distillCalls).toHaveLength(1);
    expect(distillCalls[0].skillId).toBe("deploy-the-web-app");
    expect(distillCalls[0].goal).toBe("deploy the web app");
    expect(distillCalls[0].notes.map((n) => n.slug)).toEqual([
      "proc/deploy-1",
      "proc/deploy-2",
    ]);
    expect(distillCalls[0].notes[0].body).toContain("pushed to prod");

    // Notes retired, cluster marked distilled.
    expect(deletedSlugs).toEqual(["proc/deploy-1", "proc/deploy-2"]);
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
      // no conversation. Even if the skill somehow "exists", a skip never
      // distills — the notes must be preserved.
      distillResult: { ok: true, skipReason: "pre_first_user_message" },
      existingSkillIds: ["deploy-the-web-app"],
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
      existingSkillIds: [],
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    // Skill was never created → the captured procedure must be preserved.
    expect(distillCalls).toHaveLength(1);
    expect(deletedSlugs).toEqual([]);
    expect(reg.rows.get("cluster/proc/deploy-1")!.status).toBe("ready");
    expect(outcome.distilled).toEqual([]);
    expect(outcome.distillFailures).toBe(1);
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
