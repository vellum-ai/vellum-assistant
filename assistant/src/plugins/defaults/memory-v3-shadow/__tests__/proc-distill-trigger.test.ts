/**
 * Tests for `proc-distill-trigger.ts` — the recurrence/distillation-trigger job
 * (`memory_proc_distill`).
 *
 * Every collaborator is dependency-injected via `ProcDistillTriggerDeps`: the
 * candidate-note reader, the identity matcher, the Tier-2 judge, and the
 * registry mutators. A small in-memory fake registry stands in for the SQLite
 * candidate store so these tests exercise the REAL orchestration logic (skip /
 * open / join / judge / mark-ready / idempotency) without Qdrant, an LLM, or a
 * database. Coverage:
 *   - flag off → disabled no-op;
 *   - two captures of the same goal cross the threshold → cluster `ready`;
 *   - distinct goals stay separate clusters (neither ready below threshold);
 *   - an `explicit` candidate is `ready` on first sight;
 *   - an `existing-skill` match is skipped (no cluster opened);
 *   - a gray-band case resolves via the injected judge (same → join; different → new);
 *   - re-running over already-assigned notes is idempotent (no double count).
 *
 * The logger is stubbed so the best-effort warn paths stay quiet.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../../../__tests__/helpers/mock-logger.js";
import type { AssistantConfig } from "../../../../config/types.js";
import type { MemoryJob } from "../../../../memory/jobs-store.js";
import type { CandidateClusterRef, MatchResult } from "../candidate-match.js";
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

// The gate is driven through this slot rather than the feature-flag override
// cache: `mock.module` is process-global, and a sibling file in a directory run
// (e.g. `consolidation-job.test.ts`) replaces `memory-v3-gate.js` wholesale —
// owning the mock here keeps this file's gate under this file's control.
let procToSkillsEnabledSlot = true;
mock.module("../../../../config/memory-v3-gate.js", () => ({
  isProcToSkillsEnabled: () => procToSkillsEnabledSlot,
  // The distillation launcher transitively imports the background-job runner,
  // whose import graph pulls `isMemoryV3Live`, so both gate exports must be
  // present when this mock replaces the module wholesale.
  isMemoryV3Live: () => false,
}));

const { procDistillTriggerJob } = await import("../proc-distill-trigger.js");
import type {
  CandidateNote,
  ProcDistillTriggerDeps,
} from "../proc-distill-trigger.js";

const JOB = {
  id: "job-1",
  type: "memory_proc_distill",
} as unknown as MemoryJob;

// The gating test flips the slot off; reset it so later tests stay enabled.
afterEach(() => {
  procToSkillsEnabledSlot = true;
});

function config(minRecurrence = 2): AssistantConfig {
  return {
    memory: { procToSkills: { minRecurrence } },
  } as unknown as AssistantConfig;
}

// ---------------------------------------------------------------------------
// In-memory fake registry — the real store keys every mutator on cluster_id and
// dedups member slugs; this mirrors that so the orchestration logic is exercised
// end-to-end (open → increment + addMember → re-read count → mark ready).
// ---------------------------------------------------------------------------

function fakeRegistry() {
  const rows = new Map<string, ProcCandidate>();
  const store: Pick<
    ProcDistillTriggerDeps,
    | "upsertCandidate"
    | "incrementCandidate"
    | "setCandidateExplicit"
    | "addMemberNote"
    | "getCandidate"
    | "markCandidateStatus"
    | "listClusters"
    | "listReadyClusters"
  > = {
    upsertCandidate: (input) => {
      const existing = rows.get(input.clusterId);
      if (existing) {
        existing.goal = input.goal;
        return;
      }
      rows.set(input.clusterId, {
        clusterId: input.clusterId,
        goal: input.goal,
        memberNoteSlugs: [...input.memberNoteSlugs],
        count: input.count,
        status: "observing",
        explicit: input.explicit,
        createdAt: 0,
        updatedAt: 0,
      });
    },
    incrementCandidate: (clusterId) => {
      const row = rows.get(clusterId);
      if (row) row.count += 1;
    },
    setCandidateExplicit: (clusterId) => {
      const row = rows.get(clusterId);
      if (row) row.explicit = true;
    },
    addMemberNote: (clusterId, slug) => {
      const row = rows.get(clusterId);
      if (row && !row.memberNoteSlugs.includes(slug)) {
        row.memberNoteSlugs.push(slug);
      }
    },
    getCandidate: (clusterId) => rows.get(clusterId) ?? null,
    markCandidateStatus: (clusterId, status) => {
      const row = rows.get(clusterId);
      if (row) row.status = status;
    },
    listClusters: (): CandidateClusterRef[] =>
      [...rows.values()].map((r) => ({
        clusterId: r.clusterId,
        memberNoteSlugs: r.memberNoteSlugs,
      })),
    listReadyClusters: (): ProcCandidate[] =>
      [...rows.values()].filter((r) => r.status === "ready"),
  };
  return { rows, store };
}

function note(slug: string, goal: string, explicit = false): CandidateNote {
  return { slug, goal, explicit };
}

/**
 * A matcher keyed on the goal string: an exact goal already owned by a cluster
 * (by `goal`) → `cluster`; a goal in `skills` → `existing-skill`; a goal in
 * `gray` → `gray` against the named cluster; otherwise `new`. Lets each test
 * drive a deterministic tier outcome without embeddings.
 */
function makeMatcher(opts: {
  skills?: Set<string>;
  gray?: Map<string, string>;
}) {
  return (
    goal: string,
    listClusters: () => CandidateClusterRef[],
    clustersByGoal: Map<string, string>,
  ): Promise<MatchResult> => {
    if (opts.skills?.has(goal)) {
      return Promise.resolve({ kind: "existing-skill", skillId: "some-skill" });
    }
    const grayCluster = opts.gray?.get(goal);
    if (grayCluster) {
      return Promise.resolve({ kind: "gray", clusterId: grayCluster });
    }
    const owning = clustersByGoal.get(goal);
    if (owning && listClusters().some((c) => c.clusterId === owning)) {
      return Promise.resolve({ kind: "cluster", clusterId: owning });
    }
    return Promise.resolve({ kind: "new" });
  };
}

interface HarnessOpts {
  notes: CandidateNote[];
  minRecurrence?: number;
  skills?: Set<string>;
  gray?: Map<string, string>;
  judge?: ProcDistillTriggerDeps["judge"];
  seed?: Array<{ clusterId: string; goal: string; members: string[] }>;
}

function harness(opts: HarnessOpts) {
  const { rows, store } = fakeRegistry();
  // `clusterId` for a `new` note is `cluster/<slug>`; map goal → that id so a
  // second same-goal note resolves to `cluster` against the first.
  const clustersByGoal = new Map<string, string>();
  for (const seed of opts.seed ?? []) {
    store.upsertCandidate({
      clusterId: seed.clusterId,
      goal: seed.goal,
      memberNoteSlugs: seed.members,
      count: seed.members.length,
      explicit: false,
    });
    clustersByGoal.set(seed.goal, seed.clusterId);
  }
  for (const n of opts.notes) {
    if (!clustersByGoal.has(n.goal)) {
      clustersByGoal.set(n.goal, `cluster/${n.slug}`);
    }
  }

  const judgeCalls: Array<[string, string]> = [];
  const matcher = makeMatcher({ skills: opts.skills, gray: opts.gray });

  const deps: ProcDistillTriggerDeps = {
    config: config(opts.minRecurrence),
    loadCandidateNotes: async () => opts.notes,
    listClusters: store.listClusters,
    matchCandidate: (goal, listClusters) =>
      matcher(goal, listClusters, clustersByGoal),
    judge:
      opts.judge ??
      (async (a, b) => {
        judgeCalls.push([a, b]);
        return false;
      }),
    upsertCandidate: store.upsertCandidate,
    incrementCandidate: store.incrementCandidate,
    setCandidateExplicit: store.setCandidateExplicit,
    addMemberNote: store.addMemberNote,
    getCandidate: store.getCandidate,
    markCandidateStatus: store.markCandidateStatus,
    listReadyClusters: store.listReadyClusters,
    // These tally-only tests assert on the recurrence phase. The distillation
    // phase finds no member-note bodies (`loadClusterNotes` returns none), so
    // it never launches an agent or deletes a note — a `ready` cluster stays
    // `ready`. Distillation behavior is covered in `proc-distill.test.ts`.
    loadClusterNotes: async () => [],
    distill: async () => ({ ok: false }),
    skillExists: () => false,
    deleteNote: async () => {},
  };
  return { rows, deps, judgeCalls };
}

describe("procDistillTriggerJob — gating", () => {
  test("flag off → disabled no-op (matcher never called)", async () => {
    procToSkillsEnabledSlot = false;
    let matched = 0;
    const { rows } = fakeRegistry();
    const outcome = await procDistillTriggerJob(JOB, config(), {
      config: config(),
      loadCandidateNotes: async () => [note("proc/a", "do a")],
      listClusters: () => [],
      matchCandidate: async () => {
        matched += 1;
        return { kind: "new" };
      },
      judge: async () => false,
      upsertCandidate: () => {},
      incrementCandidate: () => {},
      setCandidateExplicit: () => {},
      addMemberNote: () => {},
      getCandidate: () => null,
      markCandidateStatus: () => {},
      listReadyClusters: () => [],
      loadClusterNotes: async () => [],
      distill: async () => ({ ok: false }),
      skillExists: () => false,
      deleteNote: async () => {},
    });
    expect(outcome.disabled).toBe(true);
    expect(matched).toBe(0);
    expect(rows.size).toBe(0);
  });
});

describe("procDistillTriggerJob — recurrence", () => {
  test("two captures of the same goal cross the threshold → cluster ready", async () => {
    const { rows, deps } = harness({
      notes: [
        note("proc/deploy-1", "deploy the web app"),
        note("proc/deploy-2", "deploy the web app"),
      ],
      minRecurrence: 2,
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    expect(outcome.opened).toBe(1);
    expect(outcome.joined).toBe(1);
    expect(rows.size).toBe(1);
    const cluster = rows.get("cluster/proc/deploy-1")!;
    expect(cluster.count).toBe(2);
    expect(cluster.memberNoteSlugs).toEqual(["proc/deploy-1", "proc/deploy-2"]);
    expect(cluster.status).toBe("ready");
    expect(outcome.markedReady).toEqual(["cluster/proc/deploy-1"]);
  });

  test("a single capture stays observing below the threshold", async () => {
    const { rows, deps } = harness({
      notes: [note("proc/deploy-1", "deploy the web app")],
      minRecurrence: 2,
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    expect(outcome.opened).toBe(1);
    expect(outcome.markedReady).toEqual([]);
    expect(rows.get("cluster/proc/deploy-1")!.status).toBe("observing");
    expect(rows.get("cluster/proc/deploy-1")!.count).toBe(1);
  });

  test("distinct goals stay separate clusters; neither ready below threshold", async () => {
    const { rows, deps } = harness({
      notes: [
        note("proc/deploy", "deploy the web app"),
        note("proc/rotate", "rotate the signing secrets"),
      ],
      minRecurrence: 2,
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    expect(outcome.opened).toBe(2);
    expect(outcome.joined).toBe(0);
    expect(rows.size).toBe(2);
    expect(rows.get("cluster/proc/deploy")!.count).toBe(1);
    expect(rows.get("cluster/proc/rotate")!.count).toBe(1);
    expect(outcome.markedReady).toEqual([]);
  });
});

describe("procDistillTriggerJob — explicit fast-path", () => {
  test("an explicit candidate is ready on first sight", async () => {
    const { rows, deps } = harness({
      notes: [note("proc/always-x", "always do X", true)],
      minRecurrence: 2,
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    expect(outcome.opened).toBe(1);
    const cluster = rows.get("cluster/proc/always-x")!;
    expect(cluster.count).toBe(1);
    expect(cluster.explicit).toBe(true);
    expect(cluster.status).toBe("ready");
    expect(outcome.markedReady).toEqual(["cluster/proc/always-x"]);
  });

  test("an explicit note joining an existing sub-threshold cluster → ready", async () => {
    // A passively-seeded cluster with count 1 (below minRecurrence 2). An
    // explicit note matching it must propagate explicit onto the cluster so the
    // readiness check fires on `cluster.explicit` despite count < threshold.
    const { rows, deps } = harness({
      notes: [note("proc/deploy-explicit", "deploy the web app", true)],
      seed: [
        {
          clusterId: "cluster/deploy-rituals",
          goal: "deploy the web app",
          members: ["proc/deploy-observed"],
        },
      ],
      minRecurrence: 2,
    });
    // Sanity: the seed cluster starts non-explicit and below threshold.
    expect(rows.get("cluster/deploy-rituals")!.explicit).toBe(false);
    expect(rows.get("cluster/deploy-rituals")!.count).toBe(1);

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    expect(outcome.joined).toBe(1);
    expect(outcome.opened).toBe(0);
    const cluster = rows.get("cluster/deploy-rituals")!;
    // count is now 2 (also ≥ threshold), but the point is explicit propagated.
    expect(cluster.explicit).toBe(true);
    expect(cluster.status).toBe("ready");
    expect(outcome.markedReady).toEqual(["cluster/deploy-rituals"]);
  });

  test("explicit note joins a cluster still below threshold → ready via explicit", async () => {
    // minRecurrence 3 so the joined count (2) stays below the threshold — the
    // ONLY thing that can mark it ready is the propagated explicit flag.
    const { rows, deps } = harness({
      notes: [note("proc/deploy-explicit", "deploy the web app", true)],
      seed: [
        {
          clusterId: "cluster/deploy-rituals",
          goal: "deploy the web app",
          members: ["proc/deploy-observed"],
        },
      ],
      minRecurrence: 3,
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    expect(outcome.joined).toBe(1);
    const cluster = rows.get("cluster/deploy-rituals")!;
    expect(cluster.count).toBe(2); // below minRecurrence 3
    expect(cluster.explicit).toBe(true);
    expect(cluster.status).toBe("ready");
    expect(outcome.markedReady).toEqual(["cluster/deploy-rituals"]);
  });
});

describe("procDistillTriggerJob — existing skill", () => {
  test("a goal matching an existing skill is skipped (no cluster)", async () => {
    const { rows, deps } = harness({
      notes: [note("proc/known", "ship the release")],
      skills: new Set(["ship the release"]),
      minRecurrence: 2,
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    expect(outcome.existingSkill).toBe(1);
    expect(outcome.opened).toBe(0);
    expect(outcome.joined).toBe(0);
    expect(rows.size).toBe(0);
  });
});

describe("procDistillTriggerJob — gray band (Tier-2 judge)", () => {
  test("judge says same → joins the gray cluster", async () => {
    const { rows, deps, judgeCalls } = harness({
      notes: [note("proc/deploy-prod", "deploy to production")],
      seed: [
        {
          clusterId: "cluster/deploy-rituals",
          goal: "deploy to staging",
          members: ["proc/deploy-staging"],
        },
      ],
      gray: new Map([["deploy to production", "cluster/deploy-rituals"]]),
      judge: async () => true,
      minRecurrence: 2,
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    expect(outcome.judged).toBe(1);
    expect(outcome.joined).toBe(1);
    expect(outcome.opened).toBe(0);
    const cluster = rows.get("cluster/deploy-rituals")!;
    expect(cluster.count).toBe(2);
    expect(cluster.memberNoteSlugs).toContain("proc/deploy-prod");
    // count 2 >= minRecurrence 2 → ready.
    expect(cluster.status).toBe("ready");
    expect(judgeCalls).toEqual([]); // overridden judge doesn't record
  });

  test("judge says different → opens a new cluster (bias to precision)", async () => {
    const { rows, deps } = harness({
      notes: [note("proc/deploy-prod", "deploy to production")],
      seed: [
        {
          clusterId: "cluster/deploy-rituals",
          goal: "deploy preview",
          members: ["proc/deploy-preview"],
        },
      ],
      gray: new Map([["deploy to production", "cluster/deploy-rituals"]]),
      judge: async () => false,
      minRecurrence: 2,
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    expect(outcome.judged).toBe(1);
    expect(outcome.opened).toBe(1);
    expect(outcome.joined).toBe(0);
    // The gray cluster is untouched; a fresh cluster is opened.
    expect(rows.get("cluster/deploy-rituals")!.count).toBe(1);
    expect(rows.get("cluster/proc/deploy-prod")!.count).toBe(1);
  });
});

describe("procDistillTriggerJob — idempotency", () => {
  test("re-running over an already-assigned note does not double-count", async () => {
    // Note already a member of an existing cluster (count 2, ready).
    const { rows, deps } = harness({
      notes: [note("proc/deploy-1", "deploy the web app")],
      seed: [
        {
          clusterId: "cluster/proc/deploy-1",
          goal: "deploy the web app",
          members: ["proc/deploy-1", "proc/deploy-2"],
        },
      ],
      minRecurrence: 2,
    });
    // Mark it ready up front so the pass would only re-touch it if it (wrongly)
    // re-tallied the assigned note.
    rows.get("cluster/proc/deploy-1")!.count = 2;

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    expect(outcome.skippedAssigned).toBe(1);
    expect(outcome.opened).toBe(0);
    expect(outcome.joined).toBe(0);
    // Count unchanged — the assigned note was never re-counted.
    expect(rows.get("cluster/proc/deploy-1")!.count).toBe(2);
    expect(rows.get("cluster/proc/deploy-1")!.memberNoteSlugs).toEqual([
      "proc/deploy-1",
      "proc/deploy-2",
    ]);
  });

  test("two same-goal notes in ONE pass open exactly one cluster (count 2)", async () => {
    const { rows, deps } = harness({
      notes: [
        note("proc/a", "tidy the inbox"),
        note("proc/b", "tidy the inbox"),
      ],
      minRecurrence: 2,
    });

    const outcome = await procDistillTriggerJob(JOB, deps.config, deps);

    // First note opens cluster/proc/a; second resolves to it via the matcher.
    expect(outcome.opened).toBe(1);
    expect(outcome.joined).toBe(1);
    expect(rows.size).toBe(1);
    expect(rows.get("cluster/proc/a")!.count).toBe(2);
    expect(rows.get("cluster/proc/a")!.status).toBe("ready");
  });
});
