/**
 * Memory v3 — `memory_proc_distill` job handler (recurrence/distillation trigger).
 *
 * A gated, best-effort follow-up to consolidation (active only when the
 * procedural-memory-as-skills flag is on AND memory-v3 is live). Consolidation captures a
 * freshly-seen procedure as a `kind: proc-candidate` note (PR 6); this pass
 * decides whether that note is a NEW procedure or another run of one we have
 * already been tracking, tallies recurrence in the candidate registry (PR 3),
 * and marks a cluster `ready` once it has crossed the threshold — then distills
 * each `ready` cluster into a real, registered skill.
 *
 * The pass has two phases:
 *   1. TALLY — classify each candidate note against the skill catalog and the
 *      existing clusters, opening/joining clusters and marking those that cross
 *      the recurrence threshold (or were seeded explicitly) `ready`.
 *   2. DISTILL — for each `ready` cluster, launch a guardian background agent
 *      run that reads the cluster's member notes, synthesizes the canonical
 *      procedure across the ≥ N traces, and registers it as a managed skill via
 *      `scaffold_managed_skill`. Success is CONFIRMED by verifying the skill now
 *      exists — NOT by the run's `ok` flag, which is also `true` for a skipped
 *      run (the pre-first-message gate) or a turn that finished without
 *      scaffolding. Only once the skill is verified are the member notes deleted
 *      (the procedure now lives only in the skill) and the cluster marked
 *      `distilled`; on any other outcome the cluster stays `ready` and its notes
 *      are preserved so the next pass can retry safely without data loss.
 *
 * Per candidate note (its `goal:` frontmatter is the identity key — see the
 * design doc's "Candidate-identity matching"):
 *   - The identity matcher (`matchCandidate`, PR 5) classifies the goal against
 *     the live skill catalog (Tier 0) and the existing candidate clusters
 *     (Tier 1).
 *   - `existing-skill` → SKIP. The procedure already has a skill; opening a
 *     cluster would just re-distill it. (Routing the note's knowledge to a
 *     `skill:`-linked fact is the consolidation prompt's job, not this tally.)
 *   - `new` → open a fresh cluster with this note as its first member and a
 *     count of 1, carrying the note's `explicit` flag.
 *   - `cluster` → bump the matched cluster's count and add this note to its
 *     member set.
 *   - `gray` → the borderline band. Run a bounded Tier-2 judge (ONE fast-model
 *     call: "are these the same procedure?") to break the tie. Same → treat as
 *     `cluster`; different → treat as `new`. The judge breaks ties toward
 *     "different" so over-merging (the costly failure — a skill conflating two
 *     procedures) is avoided. The judge degrades to "different" on any failure.
 *
 * After every cluster touched this pass, a cluster whose `count` has reached
 * `config.memory.procToSkills.minRecurrence` — OR that was seeded from an
 * explicit user instruction (`explicit`) — is marked `ready` for distillation.
 * An explicit candidate is `ready` on first sight (its own evidence of
 * reusability); a passively-observed one waits for recurrence.
 *
 * **Idempotency.** A note already recorded as a cluster member (in ANY status)
 * is SKIPPED — it has already been tallied. Re-running the trigger over the same
 * notes (the consolidation follow-up fires every pass) therefore never
 * double-counts a note, so a cluster's `count` reflects DISTINCT member notes.
 *
 * Dependency-injectable: `deps` lets tests substitute the candidate-note reader,
 * the matcher, the Tier-2 judge, and the registry mutators without standing up
 * Qdrant, an LLM provider, or a SQLite database.
 */

import { createHash } from "node:crypto";

import { isProcToSkillsActive } from "../../../config/memory-v3-gate.js";
import { loadSkillCatalog } from "../../../config/skills.js";
import type { AssistantConfig } from "../../../config/types.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../../../daemon/trust-context.js";
import { enqueueEmbedConceptPageJob } from "../../../memory/jobs/embed-concept-page.js";
import type { MemoryJob } from "../../../memory/jobs-store.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "../../../memory/v2/constants.js";
import { getPageIndex } from "../../../memory/v2/page-index.js";
import { deletePage, readPage } from "../../../memory/v2/page-store.js";
import {
  type ProcDistillNote,
  renderProcDistillPrompt,
} from "../../../memory/v2/prompts/proc-distill.js";
import {
  createTimeout,
  extractText,
  getConfiguredProvider,
} from "../../../providers/provider-send-message.js";
import { runBackgroundJob } from "../../../runtime/background-job-runner.js";
import { validateManagedSkillId } from "../../../skills/managed-store.js";
import { getLogger } from "../../../util/logger.js";
import { getWorkspaceDir } from "../../../util/platform.js";
import {
  type CandidateClusterRef,
  matchCandidate as realMatchCandidate,
  type MatchResult,
} from "./candidate-match.js";
import {
  addMemberNote as realAddMemberNote,
  getCandidate as realGetCandidate,
  incrementCandidate as realIncrementCandidate,
  listCandidatesByStatus as realListCandidatesByStatus,
  markCandidateStatus as realMarkCandidateStatus,
  type ProcCandidate,
  type ProcCandidateStatus,
  setCandidateExplicit as realSetCandidateExplicit,
  upsertCandidate as realUpsertCandidate,
} from "./proc-candidate-store.js";

const log = getLogger("memory-v3-proc-distill");

/**
 * The lifecycle statuses whose clusters are live Tier-1 *match targets* — a new
 * note's goal can be classified into one of these. `distilled` is excluded: a
 * distilled cluster's procedure is done (its skill exists), so a re-seen
 * procedure is caught by Tier 0 (the skill catalog), not by re-matching into the
 * retired cluster.
 */
const MATCH_TARGET_STATUSES: ProcCandidateStatus[] = ["observing", "ready"];

/**
 * The lifecycle statuses whose member notes count as already *assigned* for the
 * idempotency skip set. This MUST include `distilled`: distillation's
 * `deleteNote` is best-effort and the cluster is marked `distilled` even if a
 * note delete fails, so a candidate note can legitimately remain on disk after
 * its cluster was retired. Keeping `distilled` here ensures that leftover note's
 * slug stays in the skip set, so the next pass skips it instead of re-tallying
 * it as a fresh cluster (which would happen when Tier 0's skill ANN is below
 * threshold or unavailable).
 */
const ASSIGNED_STATUSES: ProcCandidateStatus[] = [
  "observing",
  "ready",
  "distilled",
];

/** Frontmatter marker identifying a procedure candidate note (PR 6). */
const PROC_CANDIDATE_KIND = "proc-candidate";

/** Bound on the Tier-2 judge call so a hung provider can never stall the pass. */
const JUDGE_TIMEOUT_MS = 20_000;

/**
 * Title origin AND request origin for the distillation background run. The
 * request origin is the key the permission checker matches to auto-approve
 * `skill_load skill-management` / `scaffold_managed_skill` non-interactively
 * (see `isMemoryConsolidationSkillAuthoringGrant` in permissions/checker.ts).
 */
const DISTILL_ORIGIN = "memory_consolidation";

/** Short stable label for the distillation run's logs/notifications. */
const DISTILL_JOB_NAME = "memory.proc_distill";

/** Hard timeout for a single distillation agent run. */
const DISTILL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A `kind: proc-candidate` note projected to what the trigger needs: its slug
 * (the registry member key), the `goal:` identity phrase, and whether it was an
 * explicit user instruction (`explicit: true`).
 */
export interface CandidateNote {
  slug: string;
  goal: string;
  explicit: boolean;
}

/**
 * The Tier-2 judge: a bounded "are these the same procedure?" comparison for a
 * gray-band match. Returns `true` when the two goals describe the same
 * procedure. Injected so tests never reach an LLM; the production default
 * ({@link defaultJudge}) is a single bounded, temperature-0 fast-model call.
 */
export type SameProcedureJudge = (
  goalA: string,
  goalB: string,
) => Promise<boolean>;

/** Injectable collaborators; defaults wire the real implementations. */
export interface ProcDistillTriggerDeps {
  /** Active config (recurrence threshold + the matcher's embedding config). */
  config: AssistantConfig;
  /** The `kind: proc-candidate` notes currently on disk. */
  loadCandidateNotes: () => Promise<CandidateNote[]>;
  /**
   * The matcher's Tier-1 *match-target* clusters: `observing` + `ready` only
   * (see {@link MATCH_TARGET_STATUSES}). A new note's goal can be classified into
   * one of these. Distilled clusters are intentionally excluded — re-seen
   * procedures that already have a skill are caught by Tier 0, not by matching
   * into a retired cluster.
   */
  listClusters: () => CandidateClusterRef[];
  /**
   * The idempotency *skip-set* source: every registered cluster whose members
   * count as already assigned, across `observing` + `ready` + `distilled` (see
   * {@link ASSIGNED_STATUSES}). The union of these members is the set of slugs a
   * pass skips. Distinct from {@link listClusters} so a leftover note from a
   * best-effort-failed delete on a `distilled` cluster is still skipped (not
   * re-tallied) even though that cluster is no longer a Tier-1 match target.
   */
  listAssignedClusters: () => CandidateClusterRef[];
  /** Classify a goal against skills (Tier 0) and clusters (Tier 1). */
  matchCandidate: (
    goal: string,
    listClusters: () => CandidateClusterRef[],
  ) => Promise<MatchResult>;
  /** Break a gray-band tie: are these two goals the same procedure? */
  judge: SameProcedureJudge;
  /** Open a new cluster (this note is its first member, count 1). */
  upsertCandidate: (input: {
    clusterId: string;
    goal: string;
    memberNoteSlugs: string[];
    count: number;
    explicit: boolean;
  }) => void;
  /** Bump a matched cluster's recurrence tally by one. */
  incrementCandidate: (clusterId: string) => void;
  /**
   * OR `explicit` on for a matched cluster — used when an explicit note joins an
   * existing cluster so the join carries explicit-ness onto the cluster. Never
   * clobbers an already-true value.
   */
  setCandidateExplicit: (clusterId: string) => void;
  /** Record this note as a member of the matched cluster. */
  addMemberNote: (clusterId: string, slug: string) => void;
  /** Read a single cluster (to re-check its count before marking ready). */
  getCandidate: (clusterId: string) => ProcCandidate | null;
  /** Promote a cluster to `ready` for distillation. */
  markCandidateStatus: (clusterId: string, status: ProcCandidateStatus) => void;
  /** Every cluster currently in `ready` status (the distillation work queue). */
  listReadyClusters: () => ProcCandidate[];
  /**
   * Read the bodies of a cluster's member notes — the observed traces the
   * distillation agent synthesizes into the canonical procedure. A note that
   * cannot be read is dropped; the order matches `slugs`.
   */
  loadClusterNotes: (slugs: string[]) => Promise<ProcDistillNote[]>;
  /**
   * Launch the distillation agent run for one ready cluster and report whether
   * the skill was scaffolded. Injected so tests never spin up an agent; the
   * production default drives `runBackgroundJob` under the consolidation origin
   * so the permission grant fires.
   */
  distill: (input: DistillRunInput) => Promise<DistillRunResult>;
  /**
   * Confirm that a skill with this id now genuinely exists (it appears in the
   * managed-skill catalog). This is the ONLY proof a distillation run actually
   * scaffolded its skill — `distill` reporting `ok` does not establish it (a
   * skipped/no-scaffold/errored run also reports `ok`). Injected so tests never
   * depend on a real on-disk catalog.
   */
  skillExists: (skillId: string) => boolean;
  /** Delete a candidate note once its cluster has been distilled into a skill. */
  deleteNote: (slug: string) => Promise<void>;
  /**
   * Enqueue vector cleanup for a slug whose concept page was just deleted, so
   * its stale Qdrant points are pruned promptly rather than waiting on the 6h
   * maintain pass. The production default enqueues `embed_concept_page`, whose
   * handler removes the embedding when the page is gone from disk. Injected so
   * tests assert the enqueue without standing up the job store.
   */
  enqueueVectorCleanup: (slug: string) => void;
}

/** Everything the distillation agent run needs for one ready cluster. */
export interface DistillRunInput {
  clusterId: string;
  /** Stable, immutable skill id derived from the cluster goal. */
  skillId: string;
  goal: string;
  notes: ProcDistillNote[];
}

/** Outcome of one distillation agent run. */
export interface DistillRunResult {
  /**
   * True when the background run *finished without throwing*. This is NOT a
   * statement that the skill was scaffolded: the runner also returns `ok: true`
   * when the pre-first-message gate skipped the run, or when the agent turn
   * completed but never called `scaffold_managed_skill` (or the tool errored).
   * The caller MUST confirm the skill actually exists before retiring notes.
   */
  ok: boolean;
  /**
   * Set when the runner declined to execute the run (e.g. the pre-first-message
   * gate tripped). A skipped run did NOT distill anything: the cluster must be
   * left `ready` with its notes intact for a later retry.
   */
  skipReason?: string;
}

/** Outcome of one trigger pass, for the log summary and test assertions. */
export interface ProcDistillOutcome {
  /** True when the feature was inactive (flag off or v3 not live) — the pass no-ops. */
  disabled: boolean;
  /** Candidate notes that were already cluster members and so were skipped. */
  skippedAssigned: number;
  /** Notes whose goal matched a live skill — no cluster opened. */
  existingSkill: number;
  /** New clusters opened this pass. */
  opened: number;
  /** Existing clusters this note joined (count bumped). */
  joined: number;
  /** Gray-band notes resolved by the Tier-2 judge. */
  judged: number;
  /** Clusters marked `ready` this pass. */
  markedReady: string[];
  /** Clusters distilled into a skill this pass (now `distilled`). */
  distilled: string[];
  /**
   * Ready clusters whose distillation run failed (or scaffolded nothing) and
   * were left `ready` with their notes intact for a later retry.
   */
  distillFailures: number;
  /** Per-note failures (matcher/judge/store) that did not abort the pass. */
  failures: number;
}

/**
 * Run one recurrence/distillation-trigger pass.
 *
 * No-ops (returns a disabled outcome) unless procedural-memory-as-skills is
 * active — the flag is on AND memory-v3 is live (see {@link isProcToSkillsActive}).
 * The candidate notes this pass tallies are only written under v3-live, so the
 * pass has nothing to do when v3 is not live. Best-effort: a failure tallying
 * one note is logged and recorded but never aborts the rest of the pass.
 */
export async function procDistillTriggerJob(
  _job: MemoryJob,
  config: AssistantConfig,
  deps: ProcDistillTriggerDeps = defaultDeps(config),
): Promise<ProcDistillOutcome> {
  const outcome: ProcDistillOutcome = {
    disabled: false,
    skippedAssigned: 0,
    existingSkill: 0,
    opened: 0,
    joined: 0,
    judged: 0,
    markedReady: [],
    distilled: [],
    distillFailures: 0,
    failures: 0,
  };

  if (!isProcToSkillsActive(config)) {
    outcome.disabled = true;
    return outcome;
  }

  const notes = await deps.loadCandidateNotes();

  // Idempotency: a note already recorded as a member (in ANY assigned status —
  // observing, ready, OR distilled) has been tallied; skip it so re-running over
  // the same notes never double-counts. This reads `listAssignedClusters`, NOT
  // the Tier-1 `listClusters` set: a `distilled` cluster is excluded as a match
  // target but its members must still be skipped, because distillation's
  // `deleteNote` is best-effort — a leftover note from a failed delete would
  // otherwise be re-tallied as a brand-new cluster on the next pass.
  //
  // Recurrence is counted in DISTINCT candidate notes: one note = one observed
  // trace. The consolidation prompt enforces this by writing an append-only NEW
  // note (unique slug) per sighting rather than updating a prior note in place,
  // so each later sighting arrives as an un-assigned slug and advances the
  // count. That contract is what makes skipping already-assigned slugs correct
  // — a re-seen slug is a re-run of the SAME trace, not a new observation.
  const assigned = new Set<string>();
  for (const cluster of deps.listAssignedClusters()) {
    for (const slug of cluster.memberNoteSlugs) {
      assigned.add(slug);
    }
  }

  // Clusters this pass touched (opened or joined) — re-checked for `ready` at the
  // end. A Set so a cluster joined by two notes is evaluated once.
  const touched = new Set<string>();

  for (const note of notes) {
    if (assigned.has(note.slug)) {
      outcome.skippedAssigned += 1;
      continue;
    }

    try {
      const clusterId = await tallyNote(note, deps, outcome);
      if (clusterId) {
        touched.add(clusterId);
        // Mark this note assigned in-memory so two same-goal notes in the SAME
        // pass don't both open a cluster: the second sees the first's member.
        assigned.add(note.slug);
      }
    } catch (err) {
      outcome.failures += 1;
      log.warn(
        { err, slug: note.slug },
        "proc-distill: failed to tally candidate note; continuing",
      );
    }
  }

  // Promote any touched cluster that has crossed the recurrence threshold or was
  // seeded explicitly. Re-read the count from the store so an in-pass increment
  // is reflected.
  const minRecurrence = config.memory.procToSkills.minRecurrence;
  for (const clusterId of touched) {
    try {
      const cluster = deps.getCandidate(clusterId);
      if (!cluster) continue;
      if (cluster.status !== "observing") continue;
      if (cluster.count >= minRecurrence || cluster.explicit) {
        deps.markCandidateStatus(clusterId, "ready");
        outcome.markedReady.push(clusterId);
      }
    } catch (err) {
      outcome.failures += 1;
      log.warn(
        { err, clusterId },
        "proc-distill: failed to mark cluster ready; continuing",
      );
    }
  }

  // Distillation phase: turn every `ready` cluster into a registered skill.
  // Best-effort per cluster — a failure is recorded and the cluster left
  // `ready` (notes intact) so the next pass can retry, never aborting the rest.
  for (const cluster of deps.listReadyClusters()) {
    try {
      await distillCluster(cluster, deps, outcome);
    } catch (err) {
      outcome.distillFailures += 1;
      log.warn(
        { err, clusterId: cluster.clusterId },
        "proc-distill: failed to distill ready cluster; left ready for retry",
      );
    }
  }

  log.info(
    {
      candidates: notes.length,
      skippedAssigned: outcome.skippedAssigned,
      existingSkill: outcome.existingSkill,
      opened: outcome.opened,
      joined: outcome.joined,
      judged: outcome.judged,
      markedReady: outcome.markedReady,
      distilled: outcome.distilled,
      distillFailures: outcome.distillFailures,
      failures: outcome.failures,
    },
    "proc-distill trigger pass complete",
  );
  return outcome;
}

/**
 * Distill one `ready` cluster into a managed skill.
 *
 * Reads the cluster's member candidate notes (the observed traces), launches
 * the distillation agent run, and — only once the skill is CONFIRMED to have
 * been created BY THIS RUN — deletes the member notes (the procedure now lives
 * only in the skill) and marks the cluster `distilled`. Confirmation is by
 * `skillExists` AND `!existedBefore`, not by the run's `ok` flag: a skipped run,
 * or a turn that finished without scaffolding (or a scaffold-tool error), also
 * reports `ok: true`, and retiring the notes on that signal would destroy the
 * captured procedure while pointing a phantom `distilled` cluster at a skill
 * that does not exist.
 *
 * **The `existedBefore` guard.** `existedBefore` is sampled BEFORE the run. A
 * skill id that is already taken before this cluster runs is a collision (a
 * distinct cluster — or a pre-existing skill — already owns the id): the run's
 * `scaffold_managed_skill` will fail on the duplicate id, yet `skillExists`
 * would still pass because the OTHER skill exists. Retiring this cluster's notes
 * on that spurious pass is the data-loss bug. So a cluster whose id existed
 * BEFORE the run is never treated as distilled — its notes are preserved and it
 * stays `ready`. (Re-running the SAME cluster is not a collision: ids are now
 * keyed on the cluster, so its own already-scaffolded skill is caught by the
 * idempotency skip set / `distilled` status, not by re-entering this path.)
 *
 * The order is deliberate: notes are deleted AFTER the skill is verified, so a
 * failed/skipped/empty/colliding run leaves both the cluster `ready` and its
 * notes on disk for a safe retry.
 *
 * A cluster with no readable member notes is left `ready` untouched — there is
 * nothing to synthesize, and dropping it would lose the recurrence evidence.
 */
async function distillCluster(
  cluster: ProcCandidate,
  deps: ProcDistillTriggerDeps,
  outcome: ProcDistillOutcome,
): Promise<void> {
  const skillId = skillIdForGoal(cluster.goal, cluster.clusterId);
  if (!skillId) {
    outcome.distillFailures += 1;
    log.warn(
      { clusterId: cluster.clusterId, goal: cluster.goal },
      "proc-distill: cannot derive a valid skill id from cluster goal; skipping",
    );
    return;
  }

  const notes = await deps.loadClusterNotes(cluster.memberNoteSlugs);
  if (notes.length === 0) {
    outcome.distillFailures += 1;
    log.warn(
      { clusterId: cluster.clusterId },
      "proc-distill: ready cluster has no readable member notes; left ready",
    );
    return;
  }

  // Sample whether the id is ALREADY taken before launching. If it is, the run
  // cannot have created it — a collision (a distinct cluster or a pre-existing
  // skill already owns it). `skillExists` after the run would still pass because
  // that OTHER skill exists, so without this guard the cluster's notes would be
  // retired against a skill it never produced. A colliding cluster is left
  // `ready` with its notes intact.
  const existedBefore = deps.skillExists(skillId);
  if (existedBefore) {
    outcome.distillFailures += 1;
    log.warn(
      { clusterId: cluster.clusterId, skillId },
      "proc-distill: skill id already exists before distillation (collision); left ready, notes preserved",
    );
    return;
  }

  const result = await deps.distill({
    clusterId: cluster.clusterId,
    skillId,
    goal: cluster.goal,
    notes,
  });

  if (!result.ok) {
    outcome.distillFailures += 1;
    log.warn(
      { clusterId: cluster.clusterId, skillId },
      "proc-distill: distillation run did not complete; left ready for retry",
    );
    return;
  }

  // A skipped run (e.g. the pre-first-message gate tripped) reports `ok: true`
  // but bootstrapped no conversation — nothing was distilled. Leave the cluster
  // `ready` with its notes intact so a later pass retries once the gate clears.
  if (result.skipReason) {
    outcome.distillFailures += 1;
    log.info(
      { clusterId: cluster.clusterId, skillId, skipReason: result.skipReason },
      "proc-distill: distillation run was skipped; left ready for retry",
    );
    return;
  }

  // `ok` only means the run finished without throwing — it does NOT prove the
  // agent scaffolded the skill (the turn may have completed without ever
  // calling `scaffold_managed_skill`, or the tool may have errored). Retiring
  // the notes now would destroy the captured procedure AND leave a phantom
  // `distilled` cluster pointing at a skill that does not exist. The id did NOT
  // exist before this run (collisions were rejected above), so the skill
  // existing now is proof THIS run created it — verify that before touching
  // anything; otherwise leave the cluster `ready` with its notes intact for a
  // safe retry.
  if (!deps.skillExists(skillId)) {
    outcome.distillFailures += 1;
    log.warn(
      { clusterId: cluster.clusterId, skillId },
      "proc-distill: distillation run finished but the skill was not created; left ready for retry",
    );
    return;
  }

  // Skill registered AND verified — retire the candidate notes, then mark the
  // cluster `distilled`. Member-note deletion is best-effort: a stray note left
  // on disk is harmless (its slug is already a cluster member, so the trigger
  // skips it), whereas re-distilling would re-scaffold the same skill.
  //
  // After each successful delete, enqueue the established concept-page vector
  // cleanup for that slug. `deletePage` only touches disk + the edge/page
  // indexes; the slug's Qdrant points are pruned out-of-band by the 6h maintain
  // pass, so until then retrieval could still surface the procedural prose that
  // just moved into the skill. `embed_concept_page` over a now-missing page
  // deletes its prior embedding (see `embedConceptPageJob`), so enqueuing it
  // here makes the vector cleanup prompt instead of waiting on maintain.
  for (const slug of cluster.memberNoteSlugs) {
    try {
      await deps.deleteNote(slug);
    } catch (err) {
      log.warn(
        { err, clusterId: cluster.clusterId, slug },
        "proc-distill: failed to delete distilled candidate note; continuing",
      );
      continue;
    }
    deps.enqueueVectorCleanup(slug);
  }

  deps.markCandidateStatus(cluster.clusterId, "distilled");
  outcome.distilled.push(cluster.clusterId);
  log.info(
    { clusterId: cluster.clusterId, skillId },
    "proc-distill: distilled ready cluster into a managed skill",
  );
}

/**
 * Derive a stable, immutable skill id from a cluster.
 *
 * The id is the `skill:` link target future facts reference (PR 2), so it must
 * be deterministic for a given cluster and valid per the managed-skill id rules
 * (`^[a-z0-9][a-z0-9._-]*$`, no path traversal). Returns `null` when the goal
 * has no usable alphanumeric content to slugify.
 *
 * **Collision resistance.** The human-readable part is the goal slug truncated
 * to the first 64 chars, so two *distinct* clusters whose goals share that
 * prefix — or two unrelated goals that both slugify to the same head — would
 * otherwise produce identical ids. A colliding id is a data-loss hazard: the
 * second cluster's `scaffold_managed_skill` fails on the already-taken id, yet
 * `skillExists` still passes (the OTHER cluster's skill exists), so the second
 * cluster's notes would be retired as if distilled. To make the id injective in
 * the cluster, a short deterministic disambiguator derived from the cluster
 * `seed` (its stable cluster id) is appended. Same cluster → same id on every
 * pass (idempotent re-distill); two distinct clusters → distinct ids even when
 * their goal slugs are identical.
 */
export function skillIdForGoal(goal: string, seed?: string): string | null {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (slug.length === 0) return null;
  // Append a short, deterministic disambiguator keyed on the cluster's stable
  // id (or, when no seed is given, the full goal) so two distinct clusters
  // whose goal slugs collide on the truncated head still get distinct ids.
  // Hyphen + lowercase hex is within the managed-skill id charset.
  const id = `${slug}-${shortHash(seed ?? goal)}`;
  // Defense in depth: the slug shape already satisfies the managed-skill id
  // rules, but validate so a future change to either side can't silently
  // produce an id `scaffold_managed_skill` would reject.
  return validateManagedSkillId(id) === null ? id : null;
}

/**
 * A short, deterministic, collision-resistant hex tag for `input`. Used as the
 * skill-id disambiguator: deterministic (same input → same tag) and confined to
 * `[0-9a-f]`, which is inside the managed-skill id charset. Eight hex chars of
 * SHA-256 give ample separation between the small number of clusters that ever
 * share a truncated goal slug.
 */
function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/**
 * Classify one un-assigned note and apply the registry mutation. Returns the
 * cluster id it landed in (so the caller can re-check it for `ready`), or
 * `null` when the note matched an existing skill (no cluster).
 *
 * The in-pass `listClusters` is re-read on every note so a cluster OPENED
 * earlier this pass is visible to the matcher's Tier-1 set for later notes.
 */
async function tallyNote(
  note: CandidateNote,
  deps: ProcDistillTriggerDeps,
  outcome: ProcDistillOutcome,
): Promise<string | null> {
  let result = await deps.matchCandidate(note.goal, deps.listClusters);

  // Resolve a gray-band match with the Tier-2 judge: same procedure → join the
  // cluster; different → a genuinely new procedure. Biased to "different".
  if (result.kind === "gray") {
    outcome.judged += 1;
    const grayCluster = deps.getCandidate(result.clusterId);
    const sameProcedure = grayCluster
      ? await deps.judge(note.goal, grayCluster.goal)
      : false;
    result = sameProcedure
      ? { kind: "cluster", clusterId: result.clusterId }
      : { kind: "new" };
  }

  switch (result.kind) {
    case "existing-skill":
      outcome.existingSkill += 1;
      return null;
    case "cluster":
      deps.incrementCandidate(result.clusterId);
      deps.addMemberNote(result.clusterId, note.slug);
      // Carry explicit-ness onto the cluster when an explicit note joins (covers
      // the gray→cluster path too, which resolves to `kind: "cluster"`). The
      // readiness check below consults `cluster.explicit`, so without this an
      // explicit instruction joining an existing sub-threshold cluster would
      // never bypass recurrence. OR-in: never clobbers an already-explicit row.
      if (note.explicit) deps.setCandidateExplicit(result.clusterId);
      outcome.joined += 1;
      return result.clusterId;
    case "new": {
      const clusterId = clusterIdForNote(note.slug);
      deps.upsertCandidate({
        clusterId,
        goal: note.goal,
        memberNoteSlugs: [note.slug],
        count: 1,
        explicit: note.explicit,
      });
      outcome.opened += 1;
      return clusterId;
    }
  }
}

/**
 * Derive a stable cluster id from the seeding note's slug. The note slug is
 * already unique and immutable, so `cluster/<slug>` is a deterministic,
 * collision-free key — re-running the pass over the same un-assigned note (e.g.
 * after a crash before the member set persisted) reuses the same cluster row
 * rather than forking a duplicate.
 */
function clusterIdForNote(slug: string): string {
  return `cluster/${slug}`;
}

// ---------------------------------------------------------------------------
// Default (production) collaborators
// ---------------------------------------------------------------------------

function defaultDeps(config: AssistantConfig): ProcDistillTriggerDeps {
  const workspaceDir = getWorkspaceDir();
  return {
    config,
    loadCandidateNotes: () => loadCandidateNotesFromWorkspace(workspaceDir),
    listClusters: listMatchTargetClustersFromRegistry,
    listAssignedClusters: listAssignedClustersFromRegistry,
    matchCandidate: (goal, listClusters) =>
      realMatchCandidate(goal, { config, listCandidateClusters: listClusters }),
    judge: (goalA, goalB) => defaultJudge(goalA, goalB),
    upsertCandidate: realUpsertCandidate,
    incrementCandidate: realIncrementCandidate,
    setCandidateExplicit: realSetCandidateExplicit,
    addMemberNote: realAddMemberNote,
    getCandidate: realGetCandidate,
    markCandidateStatus: realMarkCandidateStatus,
    listReadyClusters: () => realListCandidatesByStatus("ready"),
    loadClusterNotes: (slugs) =>
      loadClusterNotesFromWorkspace(workspaceDir, slugs),
    distill: launchDistillation,
    skillExists: skillExistsInCatalog,
    deleteNote: (slug) => deletePage(workspaceDir, slug),
    enqueueVectorCleanup: (slug) => {
      enqueueEmbedConceptPageJob({ slug });
    },
  };
}

/**
 * Enumerate concept pages, read each, and project the `kind: proc-candidate`
 * ones to `{ slug, goal, explicit }`. The `goal:`/`explicit:` keys pass through
 * the frontmatter schema's `.passthrough()` (they are conventions of the
 * proc-candidate note shape, not declared fields). A note without a usable
 * `goal:` string is dropped — the matcher has nothing to key identity on.
 */
async function loadCandidateNotesFromWorkspace(
  workspaceDir: string,
): Promise<CandidateNote[]> {
  const index = await getPageIndex(workspaceDir);
  const notes: CandidateNote[] = [];
  for (const entry of index.entries) {
    // Synthetic capability rows (skills/CLI) have no on-disk page; their mtime
    // is 0. Skip them — only real concept pages can be proc-candidate notes.
    if (entry.modifiedAt === 0) continue;
    let page;
    try {
      page = await readPage(workspaceDir, entry.slug);
    } catch {
      continue;
    }
    if (!page) continue;
    const fm = page.frontmatter as Record<string, unknown>;
    if (fm.kind !== PROC_CANDIDATE_KIND) continue;
    const goal = typeof fm.goal === "string" ? fm.goal.trim() : "";
    if (goal.length === 0) continue;
    notes.push({ slug: entry.slug, goal, explicit: fm.explicit === true });
  }
  return notes;
}

/** Project the clusters in `statuses` to their `{ clusterId, memberNoteSlugs }`. */
function listClustersFromRegistry(
  statuses: ProcCandidateStatus[],
): CandidateClusterRef[] {
  const clusters: CandidateClusterRef[] = [];
  for (const status of statuses) {
    for (const candidate of realListCandidatesByStatus(status)) {
      clusters.push({
        clusterId: candidate.clusterId,
        memberNoteSlugs: candidate.memberNoteSlugs,
      });
    }
  }
  return clusters;
}

/** Default Tier-1 match targets: `observing` + `ready` clusters only. */
function listMatchTargetClustersFromRegistry(): CandidateClusterRef[] {
  return listClustersFromRegistry(MATCH_TARGET_STATUSES);
}

/**
 * Default idempotency skip-set source: `observing` + `ready` + `distilled`. The
 * `distilled` rows carry any notes a best-effort delete left behind, keeping
 * those slugs in the skip set so the next pass never re-tallies them.
 */
function listAssignedClustersFromRegistry(): CandidateClusterRef[] {
  return listClustersFromRegistry(ASSIGNED_STATUSES);
}

/**
 * Read the bodies of a cluster's member notes as the distillation traces. A
 * note that is missing or unreadable is dropped (best-effort) — the surviving
 * traces still describe the procedure, and a vanished note is just one fewer
 * sample.
 */
async function loadClusterNotesFromWorkspace(
  workspaceDir: string,
  slugs: string[],
): Promise<ProcDistillNote[]> {
  const notes: ProcDistillNote[] = [];
  for (const slug of slugs) {
    try {
      const page = await readPage(workspaceDir, slug);
      if (page) notes.push({ slug, body: page.body });
    } catch {
      // Skip an unreadable note; the rest still distill.
    }
  }
  return notes;
}

/**
 * Production distillation launcher: a guardian background agent run that reads
 * the cluster's traces, synthesizes the canonical procedure, and scaffolds the
 * managed skill. It runs under the `memory_consolidation` request origin so the
 * permission checker auto-approves `skill_load skill-management` /
 * `scaffold_managed_skill` without an interactive prompt (the run has no client
 * to answer one).
 *
 * Reports `ok` and any `skipReason` from `runBackgroundJob`. `ok` only means
 * the run finished without throwing — it does NOT establish that the agent
 * scaffolded the skill (the gate may have skipped the run, or the turn may have
 * completed without calling `scaffold_managed_skill`). The caller verifies the
 * skill actually exists (`skillExists`) before retiring the cluster's notes;
 * `ok: false`, a `skipReason`, or a missing skill all keep the cluster `ready`
 * with its notes intact for a safe retry.
 */
async function launchDistillation(
  input: DistillRunInput,
): Promise<DistillRunResult> {
  const result = await runBackgroundJob({
    jobName: DISTILL_JOB_NAME,
    source: MEMORY_V2_CONSOLIDATION_SOURCE,
    prompt: renderProcDistillPrompt({
      skillId: input.skillId,
      goal: input.goal,
      notes: input.notes,
    }),
    systemHint: "Procedure distillation",
    trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
    callSite: "memoryV2Consolidation",
    timeoutMs: DISTILL_TIMEOUT_MS,
    origin: DISTILL_ORIGIN,
    requestOrigin: DISTILL_ORIGIN,
    suppressFailureNotifications: true,
  });
  return { ok: result.ok, skipReason: result.skipReason };
}

/**
 * Production skill-existence check: does a managed skill with this id appear in
 * the live catalog? `loadSkillCatalog()` includes scaffolded managed skills, so
 * a successful `scaffold_managed_skill` from the distillation run shows up here.
 * This is what proves the run actually created the skill before we retire the
 * cluster's candidate notes.
 */
function skillExistsInCatalog(skillId: string): boolean {
  return loadSkillCatalog().some((skill) => skill.id === skillId);
}

/**
 * Production Tier-2 judge: ONE bounded, temperature-0 fast-model call asking
 * whether two goal phrases describe the same procedure. Biased to "different"
 * — any unconfigured provider, error, timeout, or non-affirmative answer
 * resolves to `false`, so the costly over-merge never happens on a judge miss.
 */
async function defaultJudge(goalA: string, goalB: string): Promise<boolean> {
  const provider = await getConfiguredProvider("memoryV2Consolidation");
  if (!provider) return false;

  const prompt = [
    "You are deciding whether two captured procedures are THE SAME reusable",
    'procedure (same goal/intent), not whether their steps happen to match. Answer "yes"',
    'only if they are the same procedure; otherwise answer "no". Bias toward "no" —',
    'near-misses like "deploy preview" vs "deploy production" are DIFFERENT procedures.',
    "",
    `Procedure A: ${goalA}`,
    `Procedure B: ${goalB}`,
    "",
    'Answer with exactly one word: "yes" or "no".',
  ].join("\n");

  const { signal, cleanup } = createTimeout(JUDGE_TIMEOUT_MS);
  try {
    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: prompt }] }],
      {
        config: {
          callSite: "memoryV2Consolidation",
          temperature: 0,
          thinking: { type: "disabled" },
        },
        signal,
      },
    );
    return /\byes\b/i.test(extractText(response));
  } catch (err) {
    log.warn(
      { err },
      "proc-distill Tier-2 judge failed; treating as different (bias to precision)",
    );
    return false;
  } finally {
    cleanup();
  }
}
