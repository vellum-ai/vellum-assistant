// ---------------------------------------------------------------------------
// Retrospective procedure stabilizer: capture separated from promotion.
// ---------------------------------------------------------------------------
//
// The memory retrospective still reads the full interaction trace and still
// calls `scaffold_managed_skill` with a complete proposed skill. What changes
// is what that call DOES on a retrospective-origin turn: instead of writing
// the catalog on first sight, it routes through this stabilizer, which
// records the observation as a durable candidate and decides whether the
// procedure has earned a canonical write.
//
// Promotion requires TWO DISTINCT source conversations, each contributing
// verified, procedure-attributed evidence. That rule is uniform: an existing
// assistant-authored skill identifies the canonical UPDATE TARGET but is not
// itself a corroborating episode, because its provenance predates this
// evidence check and was never validated against it.
//
// Everything the decision rests on is server-derived, never model-asserted:
//
//   - the source conversation comes from the fork's
//     `forkParentConversationId`;
//   - evidence is the model's ATTRIBUTION CLAIM (cited `tool_use` ids), which
//     the server then verifies inside the fork's copied source region,
//     requiring a matching non-error `tool_result` for each citation and
//     persisting content hashes so the validated execution stays auditable;
//   - identity against existing skills comes from the calibrated skill
//     matcher.
//
// IDENTITY, AND WHAT IS DELIBERATELY NOT CLAIMED. Candidate-side identity is
// keyed on exact values (normalized goal, proposed skill id) plus binding
// through the existing-skill matcher. There is intentionally NO similarity
// threshold between two candidate goals: `simBatch`, the only calibrated
// semantic path available, scores a query against slugs already embedded as
// concept pages, and pending candidates are deliberately not concept pages
// (an unpromoted procedure must never reach memory recall). Comparing raw
// goal embeddings would need a fresh, uncalibrated threshold, so the honest
// consequence is accepted instead: two observations that share neither
// wording nor proposed id, and match no existing skill, remain two pending
// clusters and NEITHER promotes. That is a missed promotion, never a
// spurious skill.
//
// Infrastructure failure never looks like novelty. Missing fork lineage, an
// unavailable store, an uncitable or unverifiable trace, a degraded matcher,
// or an ambiguous identity all FAIL CLOSED: an error is returned, nothing is
// written, and the observation can be retried on a later pass.

import { createHash } from "node:crypto";

import { getLogger } from "./logging.js";
import { MEMORY_RETROSPECTIVE_INSTRUCTION_KIND } from "./memory-retrospective-constants.js";
import {
  type CandidateArtifact,
  claimPromotion,
  completePromotion,
  countCandidateSources,
  type EvidenceRef,
  findLiveCandidates,
  getCandidateById,
  isCandidateStoreAvailable,
  listCandidateSources,
  normalizeGoal,
  type ProcedureCandidate,
  withCandidateDb,
  withCandidateTransaction,
  writeCandidate,
  writeCandidateSource,
} from "./procedure-candidate-store.js";
import { EXISTING_SKILL_THRESHOLD } from "./v3/candidate-match.js";

const log = getLogger("procedure-candidate-stabilizer");

/**
 * Tools the retrospective pass itself may call. A citation naming one of
 * these is rejected: the pass's own bookkeeping is not evidence that the
 * source conversation executed a procedure.
 */
const RETROSPECTIVE_OWN_TOOLS: ReadonlySet<string> = new Set([
  "remember",
  "scaffold_managed_skill",
  "find_similar_skills",
  "skill_load",
]);

export type StabilizerDecision =
  | { kind: "failed"; message: string }
  | { kind: "captured"; message: string; candidateId: string }
  | { kind: "covered"; message: string; candidateId: string }
  | {
      kind: "promote";
      candidateId: string;
      targetSkillId: string;
      sourceConversationId: string;
      artifact: CandidateArtifact;
    };

interface MessageLike {
  role: string;
  content: string | unknown[];
  metadata?: string | null;
}

export interface StabilizerDeps {
  getConversation?: (
    id: string,
  ) => { forkParentConversationId: string | null } | null;
  getMessages?: (conversationId: string) => MessageLike[];
  loadCatalog?: () => { id: string; source: string }[];
  managedSkillExists?: (skillId: string) => boolean;
  readManagedAuthor?: (skillId: string) => "assistant" | "user" | undefined;
  matchExistingSkills?: (goal: string) => Promise<{
    hits: Array<{ skillId: string; score: number }>;
    degraded: boolean;
  }>;
  now?: () => number;
  newId?: () => string;
}

interface ResolvedDeps {
  getConversation: NonNullable<StabilizerDeps["getConversation"]>;
  getMessages: NonNullable<StabilizerDeps["getMessages"]>;
  loadCatalog: NonNullable<StabilizerDeps["loadCatalog"]>;
  managedSkillExists: NonNullable<StabilizerDeps["managedSkillExists"]>;
  readManagedAuthor: NonNullable<StabilizerDeps["readManagedAuthor"]>;
  matchExistingSkills: NonNullable<StabilizerDeps["matchExistingSkills"]>;
  now: () => number;
  newId: () => string;
}

async function resolveDeps(deps: StabilizerDeps): Promise<ResolvedDeps> {
  const [
    conversationCrud,
    skills,
    installMeta,
    managedStore,
    candidateMatch,
    fs,
    path,
  ] = await Promise.all([
    import("../../../persistence/conversation-crud.js"),
    import("../../../config/skills.js"),
    import("../../../skills/install-meta.js"),
    import("../../../skills/managed-store.js"),
    import("./v3/candidate-match.js"),
    import("node:fs"),
    import("node:path"),
  ]);
  return {
    getConversation: deps.getConversation ?? conversationCrud.getConversation,
    getMessages:
      deps.getMessages ??
      (conversationCrud.getMessages as (id: string) => MessageLike[]),
    loadCatalog: deps.loadCatalog ?? (() => skills.loadSkillCatalog()),
    managedSkillExists:
      deps.managedSkillExists ??
      ((skillId: string) =>
        fs.existsSync(
          path.join(managedStore.getManagedSkillDir(skillId), "SKILL.md"),
        )),
    readManagedAuthor:
      deps.readManagedAuthor ??
      ((skillId: string) => {
        try {
          return installMeta.readInstallMeta(
            managedStore.getManagedSkillDir(skillId),
          )?.author;
        } catch {
          return undefined;
        }
      }),
    matchExistingSkills:
      deps.matchExistingSkills ??
      ((goal: string) => candidateMatch.nearestExistingSkillsDetailed(goal)),
    now: deps.now ?? (() => Date.now()),
    newId: deps.newId ?? (() => crypto.randomUUID()),
  };
}

function hashOf(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex")
    .slice(0, 32);
}

function parseBlocks(content: string | unknown[]): unknown[] {
  let blocks: unknown = content;
  if (typeof blocks === "string") {
    try {
      blocks = JSON.parse(blocks);
    } catch {
      return [];
    }
  }
  return Array.isArray(blocks) ? blocks : [];
}

/**
 * The portion of the fork that is the COPIED SOURCE TRACE: everything before
 * the retrospective's own instruction message. Citations must resolve inside
 * this region, so a pass cannot cite its own turns as evidence. Returns
 * `null` when the boundary is absent, which fails closed rather than letting
 * the whole fork count as source.
 */
function sourceTraceRegion(messages: MessageLike[]): MessageLike[] | null {
  const boundary = messages.findIndex((msg) => {
    if (!msg.metadata) {
      return false;
    }
    try {
      const meta = JSON.parse(msg.metadata) as Record<string, unknown>;
      return meta.kind === MEMORY_RETROSPECTIVE_INSTRUCTION_KIND;
    } catch {
      return false;
    }
  });
  if (boundary < 0) {
    return null;
  }
  return messages.slice(0, boundary);
}

/**
 * Verify the pass's attribution claim. Each cited id must resolve to a
 * non-authoring `tool_use` inside the source region AND carry a matching
 * non-error `tool_result`. Returns validated references (with content
 * hashes) or the reason validation failed.
 */
function validateCitedEvidence(
  sourceTrace: MessageLike[],
  citedToolUseIds: string[],
): { refs?: EvidenceRef[]; error?: string } {
  const uses = new Map<string, { name: string; input: unknown }>();
  const results = new Map<string, unknown>();
  for (const msg of sourceTrace) {
    for (const block of parseBlocks(msg.content)) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      if (msg.role === "assistant" && b.type === "tool_use") {
        if (typeof b.id === "string" && typeof b.name === "string") {
          uses.set(b.id, { name: b.name, input: b.input });
        }
        continue;
      }
      // guard:allow-tool-result-only: outcome evidence for a locally executed
      // step; a server-side web_search_tool_result carries no is_error flag
      // and never corresponds to an executed procedure step.
      if (
        msg.role === "user" &&
        b.type === "tool_result" &&
        typeof b.tool_use_id === "string" &&
        b.is_error !== true
      ) {
        results.set(b.tool_use_id, b.content);
      }
    }
  }

  const refs: EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const id of citedToolUseIds) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const use = uses.get(id);
    if (!use) {
      return {
        error: `cited evidence "${id}" is not an executed step in this conversation's trace`,
      };
    }
    if (RETROSPECTIVE_OWN_TOOLS.has(use.name)) {
      return {
        error: `cited evidence "${id}" is a \`${use.name}\` call made by this review pass, not a step the conversation executed`,
      };
    }
    if (!results.has(id)) {
      return {
        error: `cited evidence "${id}" (\`${use.name}\`) has no successful result in the trace, so the step is not proven to have worked`,
      };
    }
    refs.push({
      toolUseId: id,
      name: use.name,
      inputHash: hashOf(use.input),
      resultHash: hashOf(results.get(id)),
    });
  }
  if (refs.length === 0) {
    return { error: "no usable evidence citations" };
  }
  return { refs };
}

export interface StabilizeArgs {
  runConversationId: string | undefined;
  proposedSkillId: string;
  artifact: CandidateArtifact;
  /** `tool_use` ids the pass cites as the executed procedure. */
  citedToolUseIds: string[];
  deps?: StabilizerDeps;
}

/**
 * Decide what a retrospective-origin `scaffold_managed_skill` call should do.
 * Never writes the skill catalog: a `promote` decision hands the canonical
 * write back to the caller so creation, capability-memory refresh, telemetry,
 * and the skill-created card all keep running through the one existing path.
 */
export async function stabilizeRetrospectiveProcedure(
  args: StabilizeArgs,
): Promise<StabilizerDecision> {
  const deps = await resolveDeps(args.deps ?? {});
  const { runConversationId, proposedSkillId, artifact, citedToolUseIds } =
    args;

  const fail = (message: string): StabilizerDecision => ({
    kind: "failed",
    message,
  });

  if (!runConversationId) {
    return fail(
      "this review pass has no conversation id, so the observation cannot be bound to a source conversation. Nothing was recorded.",
    );
  }
  if (!isCandidateStoreAvailable()) {
    return fail(
      "the procedure-candidate store is unavailable, so this observation cannot be recorded durably. Nothing was written.",
    );
  }

  // ── Phase 1: verification, outside any lock ──────────────────────────────

  let sourceConversationId: string | null = null;
  try {
    sourceConversationId =
      deps.getConversation(runConversationId)?.forkParentConversationId ?? null;
  } catch (err) {
    log.warn({ err, runConversationId }, "fork lineage lookup failed");
  }
  if (!sourceConversationId) {
    return fail(
      "the source conversation behind this review pass could not be resolved, so the observation cannot be attributed to an episode. Nothing was recorded.",
    );
  }

  if (citedToolUseIds.length === 0) {
    return fail(
      "evidence_tool_use_ids is required when recording a procedure: cite the `tool_use` ids from this conversation's trace that carried the procedure you are capturing.",
    );
  }

  let sourceTrace: MessageLike[] | null;
  try {
    sourceTrace = sourceTraceRegion(deps.getMessages(runConversationId));
  } catch (err) {
    log.warn({ err, runConversationId }, "trace read failed");
    return fail(
      "this conversation's trace could not be read, so the cited evidence cannot be verified. Nothing was recorded.",
    );
  }
  if (!sourceTrace) {
    return fail(
      "the reviewed conversation's trace could not be delimited, so the cited evidence cannot be verified. Nothing was recorded.",
    );
  }

  const evidence = validateCitedEvidence(sourceTrace, citedToolUseIds);
  if (evidence.error || !evidence.refs) {
    return fail(
      `${evidence.error ?? "evidence could not be verified"}. Cite the executed steps that actually carried this procedure, or skip capturing it.`,
    );
  }

  let matchResult: {
    hits: Array<{ skillId: string; score: number }>;
    degraded: boolean;
  };
  try {
    matchResult = await deps.matchExistingSkills(artifact.description);
  } catch (err) {
    log.warn({ err }, "skill matcher threw; failing closed");
    matchResult = { hits: [], degraded: true };
  }
  if (matchResult.degraded) {
    return fail(
      "the skill matcher is unavailable, so this procedure could not be checked against existing skills. Nothing was written.",
    );
  }

  const catalog = deps.loadCatalog();
  const isForeign = (skillId: string): boolean => {
    const catalogEntry = catalog.find((s) => s.id === skillId);
    if (catalogEntry && catalogEntry.source !== "managed") {
      return true;
    }
    if (!deps.managedSkillExists(skillId)) {
      // Ownership cannot be established (no managed skill on disk), so treat
      // it as foreign: the fail-safe direction is to leave it alone.
      return true;
    }
    return deps.readManagedAuthor(skillId) !== "assistant";
  };

  // Every confident hit is a plausible canonical identity, regardless of who
  // owns it. More than one distinct identity is unresolvable.
  const confidentSkillIds = [
    ...new Set(
      matchResult.hits
        .filter((hit) => hit.score >= EXISTING_SKILL_THRESHOLD)
        .map((hit) => hit.skillId),
    ),
  ];
  if (confidentSkillIds.length > 1) {
    return fail(
      `this procedure matched ${confidentSkillIds.length} existing skills with confidence (${confidentSkillIds.join(", ")}), so its canonical identity is ambiguous. Nothing was written or merged.`,
    );
  }
  const matchedSkillId = confidentSkillIds[0] ?? null;
  const matchedIsForeign = matchedSkillId ? isForeign(matchedSkillId) : false;

  // A proposed id that collides with a skill the retrospective does not own
  // would shadow it.
  const proposedIdIsForeign =
    catalog.some((s) => s.id === proposedSkillId && s.source !== "managed") ||
    (deps.managedSkillExists(proposedSkillId) &&
      deps.readManagedAuthor(proposedSkillId) !== "assistant");

  const coveredBy = matchedIsForeign
    ? matchedSkillId
    : proposedIdIsForeign
      ? proposedSkillId
      : null;

  const now = deps.now();
  const normalizedGoal = normalizeGoal(artifact.description);

  // ── Phase 2: identity re-check and writes, serialized ────────────────────
  //
  // BEGIN IMMEDIATE: a concurrent retrospective is serialized behind this
  // block and observes the committed cluster, so two first observations
  // converge instead of forking siblings.
  const decision = withCandidateTransaction("stabilize", (db) => {
    const live = findLiveCandidates(db, {
      normalizedGoal,
      proposedSkillId,
      skillId: matchedSkillId,
    });
    const distinct = [...new Map(live.map((c) => [c.id, c])).values()];
    if (distinct.length > 1) {
      return fail(
        `this observation matches ${distinct.length} recorded procedure candidates at once, so its identity is ambiguous. Nothing was written or merged.`,
      );
    }
    const existing = distinct[0] ?? null;

    // A cluster already bound to a different canonical skill than the one the
    // matcher identified is a conflict, not a refinement.
    if (
      existing &&
      matchedSkillId &&
      !matchedIsForeign &&
      existing.matchedSkillId &&
      existing.matchedSkillId !== matchedSkillId
    ) {
      return fail(
        `this observation matches skill "${matchedSkillId}" but the recorded candidate for it is bound to "${existing.matchedSkillId}", so its canonical identity is ambiguous. Nothing was written or merged.`,
      );
    }

    const candidate: ProcedureCandidate = existing
      ? { ...existing }
      : {
          id: deps.newId(),
          normalizedGoal,
          goal: artifact.description,
          proposedSkillId,
          artifact,
          matchedSkillId: null,
          status: "pending",
          canonicalSkillId: null,
          createdAt: now,
          updatedAt: now,
        };

    // Companion bytes accumulate across observations, newest winning, so a
    // later pass that does not re-derive a script cannot drop the bytes an
    // earlier pass materialized.
    candidate.goal = artifact.description;
    candidate.artifact = {
      ...artifact,
      ...mergeCompanionFiles(existing?.artifact.files, artifact.files),
    };
    candidate.updatedAt = now;

    if (coveredBy) {
      candidate.status = "covered";
      candidate.canonicalSkillId = coveredBy;
      writeCandidate(db, candidate);
      return {
        kind: "covered" as const,
        candidateId: candidate.id,
        message: `Recorded: this procedure is already covered by the existing skill "${coveredBy}", which this pass may not modify or shadow. No skill was created or changed.`,
      };
    }

    if (matchedSkillId && !matchedIsForeign) {
      candidate.matchedSkillId = matchedSkillId;
    }
    writeCandidate(db, candidate);
    writeCandidateSource(db, {
      candidateId: candidate.id,
      sourceConversationId,
      retrospectiveConversationId: runConversationId,
      evidence: evidence.refs!,
      observedAt: now,
    });

    // Promotion needs two DISTINCT source conversations. An existing
    // assistant-authored skill supplies the target, never the second episode.
    const sourceCount = countCandidateSources(db, candidate.id);
    const alreadyPromoted =
      candidate.status === "promoted" && candidate.canonicalSkillId;
    if (sourceCount < 2 && !alreadyPromoted) {
      const repeat = (
        existing ? listCandidateSources(db, existing.id) : []
      ).filter((s) => s.sourceConversationId === sourceConversationId).length;
      return {
        kind: "captured" as const,
        candidateId: candidate.id,
        message:
          repeat > 0
            ? "Refined the recorded procedure candidate for this conversation. Repeat passes over one conversation supersede the earlier observation rather than confirming the procedure; it becomes a skill once a different conversation exercises it."
            : candidate.matchedSkillId
              ? `Recorded as a pending procedure candidate, linked to your existing skill "${candidate.matchedSkillId}" as its update target. It updates that skill once a second, different conversation exercises the same procedure.`
              : "Recorded as a pending procedure candidate. It becomes a skill once a second, different conversation exercises the same procedure.",
      };
    }

    const targetSkillId =
      candidate.canonicalSkillId ??
      candidate.matchedSkillId ??
      candidate.proposedSkillId;
    const claim = claimPromotion(db, targetSkillId, candidate.id, now);
    if (!claim.ok) {
      return fail(
        `another recorded procedure already owns the skill "${targetSkillId}", so promoting this one would collide. Nothing was written.`,
      );
    }
    return {
      kind: "promote" as const,
      candidateId: candidate.id,
      targetSkillId,
      sourceConversationId,
      artifact: candidate.artifact,
    };
  });

  if (decision === null) {
    return fail(
      "the procedure-candidate store became unavailable while recording this observation. Nothing was written.",
    );
  }
  return decision;
}

/**
 * Union companion files by path, newest bytes winning. Returns a `files`
 * fragment so an artifact with no companions stays free of an empty array.
 */
function mergeCompanionFiles(
  previous: CandidateArtifact["files"],
  next: CandidateArtifact["files"],
): { files?: Array<{ path: string; content: string }> } {
  const byPath = new Map<string, string>();
  for (const file of previous ?? []) {
    byPath.set(file.path, file.content);
  }
  for (const file of next ?? []) {
    byPath.set(file.path, file.content);
  }
  if (byPath.size === 0) {
    return {};
  }
  return { files: [...byPath].map(([path, content]) => ({ path, content })) };
}

/**
 * Finalize a promotion: mark the claim complete and the candidate promoted.
 * Called after the canonical skill write succeeds. Idempotent, and safe to
 * skip: if this never runs (crash), the claim stays open for the SAME
 * candidate, whose retry resumes and re-lands on the same skill id as an
 * update, so no user-visible or telemetry side effect can replay.
 */
export async function finalizePromotion(
  candidateId: string,
  canonicalSkillId: string,
  deps: StabilizerDeps = {},
): Promise<void> {
  const resolved = await resolveDeps(deps);
  const at = resolved.now();
  withCandidateDb("finalizePromotion", (db) => {
    const candidate = getCandidateById(db, candidateId);
    if (!candidate) {
      log.warn(
        { candidateId, canonicalSkillId },
        "promoted candidate row vanished before finalization",
      );
      return;
    }
    candidate.status = "promoted";
    candidate.canonicalSkillId = canonicalSkillId;
    candidate.updatedAt = at;
    writeCandidate(db, candidate);
    completePromotion(db, canonicalSkillId, at);
  });
}
