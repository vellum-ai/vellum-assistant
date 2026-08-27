// ---------------------------------------------------------------------------
// Memory retrospective — job handler.
// ---------------------------------------------------------------------------
//
// Re-reads the conversation messages added since the last successful
// retrospective run and wakes the assistant with an instruction to call
// `remember` on anything worth saving that wasn't captured in the moment.
//
// The run forks the source conversation through its latest message, persists
// a user-role retrospective instruction at the tail, and wakes the fork. The
// fork inherits the source's compaction state (summary + tail messages) via
// the `forkConversation` machinery, so the agent reads the conversation
// natively — including its own in-the-moment `remember` calls, which appear
// inline as `tool_use` blocks and need no re-listing.
//
// `<already_remembered>` is sourced from the cumulative `rememberedLog`
// persisted on the source conversation's state row — each successful pass
// appends its own `remember` contents (capped; see
// `memory-retrospective-state.ts`), so the dedup window spans every pass the
// cap retains, and survives GC of superseded retrospective conversations.
// State rows that predate the log column fall back to scanning the MOST
// RECENT prior retrospective background conversation rooted at the source
// conversation (linked via `forkParentConversationId`).
//
// Two pointers move under different rules — see `memory-retrospective-state.ts`
// and the plan for details.
//
//   - `lastProcessedMessageId` advances ONLY on `result.invoked === true`.
//     Wake failures keep it unchanged so the next attempt re-processes the
//     same messages. This is the load-bearing correctness invariant.
//   - `lastRunAt` advances at the end of every job that actually attempted a
//     run (success or wake failure), so the per-conversation cooldown gate
//     applies to subsequent trigger-driven enqueues. The mid-turn skip
//     deliberately leaves it untouched — see the guard in
//     `runForkBasedRetrospective` — so the turn-end trigger check can
//     requeue the run immediately instead of burning it.
//
// Daemon crash recovery: `resetRunningJobsToPending` (in jobs-store.ts) flips
// crashed `running` rows back to `pending` at startup. The orphan background
// conversations left by a mid-run crash are swept by
// `memory-retrospective-startup-cleanup.ts`.

import {
  addMessage,
  type AgentLoopExitReason,
  type ContentBlock,
  type ConversationRow,
  deleteConversation,
  getConversation,
  getConversationProcessingStartedAt,
  isConversationProcessing,
} from "@vellumai/plugin-api";

import {
  type ClientOs,
  type InterfaceId,
  isInteractiveInterface,
  parseClientOs,
  parseInterfaceId,
} from "../../../channels/types.js";
import { isV3TierActive } from "../../../config/memory-v3-gate.js";
import type { AssistantConfig } from "../../../config/types.js";
import { warmGuardianBindings } from "../../../contacts/guardian-delivery-reader.js";
import { extractTurnContextTimestamp } from "../../../context/compactor.js";
import {
  formatLocalTimestamp,
  resolveTurnTimezoneContext,
} from "../../../daemon/date-context.js";
import type { WakeToolContextPin } from "../../../daemon/tool-setup-types.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../../../daemon/trust-context.js";
import {
  forkConversationForRetrospective,
  resolveOverrideProfile,
} from "../../../persistence/conversation-crud.js";
import {
  enqueueMemoryJob,
  type MemoryJob,
  type MemoryJobType,
} from "../../../persistence/jobs-store.js";
import { resolveUserSlug } from "../../../prompts/persona-resolver.js";
import type { SystemPromptPersonaOverride } from "../../../prompts/system-prompt.js";
import { wakeAgentForOpportunity } from "../../../runtime/agent-wake.js";
import { recordWatchdogEvent } from "../../../telemetry/watchdog-events-store.js";
import { findMostRecentRetrospectiveFor } from "./find-most-recent-retrospective-for.js";
import { getLogger } from "./logging.js";
import {
  getRetrospectiveMessagesAfter,
  messagesHaveUserActivity,
} from "./memory-retrospective-accounting.js";
import {
  MEMORY_RETROSPECTIVE_FORK_SOURCE,
  MEMORY_RETROSPECTIVE_GROUP_ID,
  MEMORY_RETROSPECTIVE_INSTRUCTION_KIND,
  MEMORY_RETROSPECTIVE_ORIGIN,
  MEMORY_RETROSPECTIVE_SOURCE,
  SKILL_MANAGEMENT_SKILL_ID,
} from "./memory-retrospective-constants.js";
import { loadRetrospectiveRunMessages } from "./memory-retrospective-fork-boundary.js";
import { buildForkInstruction } from "./memory-retrospective-prompt.js";
import {
  appendToRememberedLog,
  bumpRetrospectiveLastRunAt,
  getRetrospectiveState,
  upsertRetrospectiveState,
} from "./memory-retrospective-state.js";
import { effectiveSweepLookbackMs } from "./memory-retrospective-sweep.js";

const log = getLogger("memory-retrospective-job");

/**
 * Follow-up jobs to fan out after a successful retrospective. Empty for now;
 * declared as a const so future maintenance jobs can be added without
 * touching the handler body.
 */
const FOLLOW_UP_JOB_TYPES: readonly MemoryJobType[] = [] as const;

/**
 * Age past which a source conversation's persisted `processing_started_at`
 * stamp is treated as stranded rather than live, and the retrospective
 * proceeds despite it. A turn-end flag clear can fail and be swallowed under
 * DB-lock contention while the daemon stays up, and the monitor-process
 * reaper only clears flags older than the daemon's boot time, so an
 * in-process stranded flag otherwise blocks a conversation's retrospectives
 * indefinitely. Proceeding risks only forking a half-finished display turn
 * (a review-quality concern; the fork copies complete persisted turns), which
 * is strictly better than never forming memories for the conversation again.
 */
export const STALE_SOURCE_PROCESSING_OVERRIDE_MS = 6 * 60 * 60 * 1000;

/** Watchdog check_name for the per-run retrospective outcome counter. */
const MEMORY_RETROSPECTIVE_RUN_CHECK_NAME = "memory_retrospective_run";

/**
 * The agent-loop exit that means the MODEL ended the run: it answered without
 * asking for another tool. Under every other exit something ended the run for
 * it, so whatever it had said by then is a fragment of a review rather than a
 * verdict on the window.
 */
const MODEL_DRIVEN_STOP_EXIT_REASON: AgentLoopExitReason = "no_tool_calls";

export type MemoryRetrospectiveOutcome =
  | { kind: "disabled" }
  | { kind: "no_new_messages" }
  | { kind: "no_user_activity" }
  | { kind: "source_dormant" }
  | { kind: "source_processing" }
  | { kind: "wake_failed"; reason?: string; conversationId?: string }
  | { kind: "no_usable_output"; reason?: string; conversationId?: string }
  | {
      kind: "invoked";
      backgroundConversationId: string;
      cutoffMessageId: string;
      newMessageCount: number;
      followUpJobIds: string[];
      /**
       * The pass reviewed its window and had nothing durable to save, so it
       * advanced the cursor without writing a memory. Separates the two
       * shapes a healthy run takes, which the outcome kind alone conflates.
       */
      noFindings: boolean;
    };

export async function memoryRetrospectiveJob(
  job: MemoryJob<{ conversationId?: string }>,
  config: AssistantConfig,
): Promise<MemoryRetrospectiveOutcome> {
  const sourceConversationId = job.payload.conversationId;
  if (!sourceConversationId) {
    log.warn({ jobId: job.id }, "Skipping job: missing conversationId");
    return { kind: "no_new_messages" };
  }

  // Execution-time twin of the enqueue funnel's `memory.retrospective.enabled`
  // gate: rows queued before the flag was turned off drain as no-ops instead
  // of forking. The CLI's manual `memory retrospective run` calls
  // `runForkBasedRetrospective` directly and so is unaffected: an operator's
  // explicit request overrides the flag, matching the lookback and
  // user-activity gates.
  if (!config.memory.retrospective.enabled) {
    log.info(
      { jobId: job.id, sourceConversationId },
      "Skipping job: memory.retrospective.enabled is false",
    );
    return { kind: "disabled" };
  }

  // Central health counter (admin analytics groups on the watchdog
  // check_name): one event per run with its outcome kind. A run that
  // throws records outcome "error" before the exception continues to the
  // jobs worker's retry machinery, so a fleet-wide spike in
  // `wake_failed`/`error` (e.g. a provider outage on the retrospective's
  // resolved model) is visible without log access. The emitter itself
  // never throws — the run's outcome must reach the jobs worker
  // regardless.
  const emitRunOutcome = (
    outcome: string,
    detail?: { reason?: string; noFindings?: boolean },
  ): void => {
    try {
      recordWatchdogEvent({
        checkName: MEMORY_RETROSPECTIVE_RUN_CHECK_NAME,
        value: 1,
        detail: {
          outcome,
          ...(detail?.reason ? { reason: detail.reason.slice(0, 200) } : {}),
          ...(detail?.noFindings !== undefined
            ? { noFindings: detail.noFindings }
            : {}),
        },
      });
    } catch {
      // recordWatchdogEvent already no-ops on opt-out and a missing
      // telemetry DB; anything past that is not worth surfacing here.
    }
  };

  let outcome: MemoryRetrospectiveOutcome;
  try {
    outcome = await runForkBasedRetrospective(sourceConversationId, config, {
      enforceSweepLookback: true,
      enforceUserActivityGate: true,
    });
  } catch (err) {
    emitRunOutcome("error", {
      reason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  emitRunOutcome(outcome.kind, {
    ...(outcome.kind === "wake_failed" || outcome.kind === "no_usable_output"
      ? { reason: outcome.reason }
      : {}),
    ...(outcome.kind === "invoked" ? { noFindings: outcome.noFindings } : {}),
  });
  return outcome;
}

// ---------------------------------------------------------------------------
// Fork-based path — fork the source through its latest message, persist a
// user-role retrospective instruction at the tail, and wake the fork. The
// fork inherits compaction state (summary + tail messages) via the existing
// `forkConversation` machinery, so the agent reads the conversation
// natively. Provider prompt-cache reuse of the source's prefix additionally
// requires `memory.retrospective.matchConversationProfile` — without it the
// wake resolves the call-site default model, which never shares a cache with
// the source's turns.
// ---------------------------------------------------------------------------

export async function runForkBasedRetrospective(
  sourceConversationId: string,
  config: AssistantConfig,
  opts?: {
    /**
     * Skip the run when the source's last message is older than
     * `memory.retrospective.sweepLookbackMs`. The queue handler passes this so
     * a stale pending backlog is completed as no-ops instead of run; the CLI's
     * manual command omits it — an operator's explicit request overrides the
     * window.
     */
    enforceSweepLookback?: boolean;
    /**
     * Apply the `memory.retrospective.requireUserActivity` gate to the loaded
     * slice. The queue handler passes this so rows that predate the enqueue
     * gate (or that lost their user activity to a cursor race) complete as
     * no-ops; the CLI's manual command omits it — an operator's explicit
     * request overrides the gate.
     */
    enforceUserActivityGate?: boolean;
  },
): Promise<MemoryRetrospectiveOutcome> {
  // Start stamp for the retrospective's end-to-end wall time, surfaced as
  // `durationMs` on the "invoked" log (start → invoked).
  const startedAtMs = Date.now();
  const sourceConversation = await getConversation(sourceConversationId);
  if (!sourceConversation) {
    log.warn(
      { sourceConversationId },
      "memory-retrospective (fork): source conversation not found; skipping",
    );
    return { kind: "no_new_messages" };
  }

  // Execution-time twin of the sweep's lookback window (see
  // memory-retrospective-sweep.ts). Event triggers enqueue in response to a
  // just-persisted message, so a legitimately-enqueued job's source sits
  // inside the window when the job runs; a numeric stamp older than the
  // window means the row is stale backlog, and running it would burn an
  // inference pass on a conversation the sweep no longer considers stalled.
  // A missing stamp is NOT dormancy here — the enqueue itself evidences
  // activity, unlike the sweep's scan where the stamp is the only signal.
  // Both state pointers stay untouched.
  if (opts?.enforceSweepLookback === true) {
    const lastMessageAt = sourceConversation.lastMessageAt;
    if (
      typeof lastMessageAt === "number" &&
      startedAtMs - lastMessageAt > effectiveSweepLookbackMs(config)
    ) {
      log.info(
        { sourceConversationId, lastMessageAt },
        "memory-retrospective (fork): source dormant beyond the sweep lookback; skipping",
      );
      return { kind: "source_dormant" };
    }
  }

  // Forking mid-turn would capture a half-finished display turn — incremental
  // checkpoint persistence writes complete tool turns to the DB while the
  // agent loop is still running. Check the persisted `processing_started_at`
  // column (the cross-process source of truth) instead of the in-memory
  // registry, so this guard works even when running in a separate CLI
  // process with an empty conversation registry.
  //
  // The skipped run is RETRIED, not burned. `lastRunAt` is deliberately not
  // bumped: the message-indexing hook runs the trigger check on every
  // persisted message — including the turn's final assistant message — so an
  // unbumped `lastRunAt` lets that turn-end pass re-enqueue with no cooldown
  // suppression. That is the primary, event-driven requeue: the retrospective
  // runs right after the colliding turn completes. The `source_processing`
  // outcome maps to a bounded deferral of the SAME job row at the worker
  // (see `resolveRetrospectiveOutcome` in `job-handlers.ts`); turn-end
  // trigger upserts coalesce onto that pending row, so the event-driven
  // retry keeps its immediacy while a stranded flag can no longer mint an
  // unbounded stream of fresh rows. Both state pointers stay untouched, so
  // nothing is lost.
  //
  // Stranded-flag override: a swallowed turn-end flag clear leaves the
  // persisted stamp set while the daemon stays up, where the monitor
  // process's boot-time-fenced reaper never touches it. A stamp older than
  // `STALE_SOURCE_PROCESSING_OVERRIDE_MS` is treated as stranded and the run
  // proceeds; a set-but-stampless flag reads as live (deferral bounds it).
  if (await isConversationProcessing(sourceConversationId)) {
    const processingStartedAt =
      await getConversationProcessingStartedAt(sourceConversationId);
    const stale =
      processingStartedAt != null &&
      startedAtMs - processingStartedAt > STALE_SOURCE_PROCESSING_OVERRIDE_MS;
    if (!stale) {
      log.info(
        { sourceConversationId, processingStartedAt },
        "memory-retrospective (fork): source conversation is mid-turn; deferring",
      );
      return { kind: "source_processing" };
    }
    log.warn(
      { sourceConversationId, processingStartedAt },
      "memory-retrospective (fork): processing flag is stale beyond the override window; proceeding despite it",
    );
  }

  const state = getRetrospectiveState(sourceConversationId);
  const lastProcessedMessageId = state?.lastProcessedMessageId ?? null;
  // Kind-aware slice: a prior run's own `skill-authored-card` message lands
  // AFTER the cursor that run persisted, so the raw slice would treat the
  // card as new work — a card-only tail must be `no_new_messages`, and a
  // mixed tail's cutoff must land on the last REAL message (never blindly
  // past the card, so an interleaved real message is never skipped). See
  // `memory-retrospective-accounting.ts`.
  const newMessages = getRetrospectiveMessagesAfter(
    sourceConversationId,
    lastProcessedMessageId,
  );

  if (newMessages.length === 0) {
    return { kind: "no_new_messages" };
  }

  // Execution-time twin of the enqueue funnel's user-activity gate. An
  // assistant-only slice has no user turn to anchor the review window on and
  // recaps work captured at its source, so it is deferred, not run: both
  // state pointers stay untouched and the slice is reviewed by the first
  // retrospective after real user activity arrives.
  if (
    opts?.enforceUserActivityGate === true &&
    config.memory.retrospective.requireUserActivity &&
    !messagesHaveUserActivity(newMessages)
  ) {
    log.info(
      { sourceConversationId, newMessageCount: newMessages.length },
      "memory-retrospective (fork): unprocessed tail has no user activity; skipping",
    );
    return { kind: "no_user_activity" };
  }

  const cutoffMessage = newMessages[newMessages.length - 1];
  if (!cutoffMessage) {
    return { kind: "no_new_messages" };
  }
  const cutoffMessageId = cutoffMessage.id;

  // The fork carries the source's visible window (inherited compaction
  // summary + tail rows), so the agent needs an explicit anchor telling it
  // where the review window begins. Prefer the user turn's `<turn_context>`
  // `current_time:` (the exact string the model sees in its rehydrated
  // history); fall back to `createdAt` rendered in the conversation's
  // timezone when no row in the slice carries a turn-context metadata block.
  const timezoneContext = resolveTurnTimezoneContext({
    configuredUserTimeZone: config.ui.userTimezone ?? null,
    detectedTimezone: config.ui.detectedTimezone ?? null,
  });
  const turnContextTimestamp = findFirstTurnContextTimestamp(newMessages);
  const windowStartTimestamp =
    turnContextTimestamp ??
    formatLocalTimestamp(
      newMessages[0]!.createdAt,
      timezoneContext.effectiveTimezone,
    );

  // Locate the prior retrospective and assemble the dedup baseline BEFORE
  // forking — otherwise `findMostRecentRetrospectiveFor` could locate this
  // run's own fork.
  const { prior, priorRemembers } = await resolvePriorRetrospective(
    sourceConversationId,
    state?.rememberedLog ?? [],
  );

  // Pin the fork to `cutoffMessageId` so messages arriving between the slice
  // read above and this call don't sneak into the fork. Without
  // `throughMessageId`, the fork snapshots the latest source message at fork
  // time and this run would process turns past the cutoff while state only
  // advances to `cutoffMessageId`, causing the next retrospective to
  // reprocess (and potentially re-`remember`) those same turns.
  //
  // The fork is referential: it carries the inherited compaction summary
  // and the source's hidden-prefix count, and reads the source's rows
  // through the fork point. Compacted source ⇒ summary + tail visible to
  // the agent natively.
  let forkConversationRow: Awaited<
    ReturnType<typeof forkConversationForRetrospective>
  >;
  try {
    // Referential fork: one conversation row plus memory-state seeding.
    // There is no source message-row copy.
    forkConversationRow = await forkConversationForRetrospective({
      conversationId: sourceConversationId,
      throughMessageId: cutoffMessageId,
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
      title: `${sourceConversation.title ?? "Untitled"} (Retrospective)`,
      conversationType: "background",
      groupId: MEMORY_RETROSPECTIVE_GROUP_ID,
    });
  } catch (err) {
    await bumpRetrospectiveLastRunAt(sourceConversationId, Date.now());
    log.error(
      { err, sourceConversationId },
      "memory-retrospective (fork): forkConversationForRetrospective failed",
    );
    throw err;
  }
  const forkId = forkConversationRow.id;

  const procToSkillsActive = isV3TierActive(config);
  const instruction = buildForkInstruction({
    windowStartTimestamp,
    windowAnchorKind: turnContextTimestamp ? "turn_context" : "created_at",
    priorRemembers,
    timeZone: timezoneContext.effectiveTimezone,
    isFirstPass: lastProcessedMessageId == null,
    procToSkillsActive,
    promptOverridePath: config.memory.retrospective.promptPath ?? null,
  });
  try {
    await addMessage(
      forkId,
      "user",
      JSON.stringify([{ type: "text", text: instruction }]),
      {
        metadata: { kind: MEMORY_RETROSPECTIVE_INSTRUCTION_KIND, hidden: true },
        skipIndexing: true,
      },
    );
  } catch (err) {
    log.error(
      { err, forkId, sourceConversationId },
      "memory-retrospective (fork): failed to persist instruction message",
    );
    await safeDeleteRetrospectiveConversation(
      forkId,
      FORK_DELETE_FAILURE_WARNING,
    );
    await bumpRetrospectiveLastRunAt(sourceConversationId, Date.now());
    throw err;
  }

  // Run the retrospective under the source conversation's inference profile
  // (when configured): provider prompt caches are byte-exact prefix matches
  // scoped per model, and a thinking enable/disable mismatch invalidates the
  // messages cache tier — so the fork's cached prefix is only reusable when
  // the retro resolves the SAME model/thinking/effort as the source's own
  // turns. `resolveOverrideProfile` applies the same expiry/conversation-type
  // semantics live turns use, so a missing, expired, or non-interactive
  // profile yields undefined and the wake keeps today's call-site default —
  // as does a profile name that no longer exists in `llm.profiles` (the
  // resolver's standard silent fall-through). The wake's `callSite` stays
  // `memoryRetrospective`, so logging/attribution buckets are unchanged.
  const matchedProfile = config.memory.retrospective.matchConversationProfile
    ? resolveOverrideProfile(sourceConversation)
    : undefined;

  // Persona + tool-context parity pins derived from the source conversation
  // (see `resolveSourceParityPins`), both passed unconditionally. The persona
  // override keeps the system-prompt prefix in parity (and is a review-quality
  // fix on its own); the tool-context pin keeps the wire tool surface in
  // parity — the fork always runs execution gate mode below, so the source's
  // full tool surface stays on the wire while the allowlist holds at
  // execution time.
  // Warm both guardian-delivery cache keys (vellum + unfiltered) so the sync
  // slug resolution inside resolveSourceParityPins (resolveUserSlug(undefined)),
  // including its any-channel fallback, hits fresh keys instead of falling
  // back to "default" on a cold/TTL-expired cache.
  await warmGuardianBindings();
  const { personaOverride, toolContextPin } = resolveSourceParityPins(
    sourceConversation,
    newMessages,
  );

  // `skipHintInjection: true` because the instruction is already a
  // persisted message — the wake's hint sandwich would only duplicate it.
  let wakeSucceeded = false;
  let failureReason: string | undefined;
  let wakeExitReason: AgentLoopExitReason | undefined;
  let threw: unknown;
  try {
    const result = await wakeAgentForOpportunity({
      conversationId: forkId,
      hint: "",
      source: MEMORY_RETROSPECTIVE_SOURCE,
      trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
      callSite: "memoryRetrospective",
      // `remember` saves ordinary facts; the skill-authoring trio
      // (`scaffold_managed_skill` / `skill_load` / `find_similar_skills`) lets a
      // pass author or refine a managed skill from an observed procedure. The
      // allowlist is gated on the same `procToSkillsActive` predicate as the
      // fork instruction and the checker's origin-scoped grant, so an inactive
      // install is remember-only — the authoring trio is not even named on the
      // allowlist. Any tool outside the active set is rejected at execution time.
      allowedTools: procToSkillsActive
        ? [
            "remember",
            "scaffold_managed_skill",
            "skill_load",
            "find_similar_skills",
          ]
        : ["remember"],
      // Always keep the source's full tool surface on the wire and resolve it
      // under the source's client context (`toolContextPin`). The wire tool
      // block is the first tier of the provider cache prefix
      // (tools → system → messages), so a wire filter busts cache parity with
      // the source's live turns — re-creating the cached prefix instead of
      // reading it. The allowlist still holds at execution time: non-allowlisted
      // calls are rejected before any executor or side effect runs. See
      // {@link SubagentToolGateMode} and {@link WakeToolContextPin}.
      toolGateMode: "execution" as const,
      toolContextPin,
      // Preactivate skill-management so its authoring tools (`find_similar_skills`
      // / `scaffold_managed_skill` / the `skill_load` target) are in the turn's
      // active set from turn 1; the checker's origin-scoped grant then makes them
      // callable without an interactive prompt. Same `procToSkillsActive` gate as
      // the allowlist above.
      preactivateSkillIds: procToSkillsActive
        ? [SKILL_MANAGEMENT_SKILL_ID]
        : undefined,
      // Message-tier cache-prefix parity — reproducing the source's
      // `<background_turn>` / `<channel_capabilities>` / `<non_interactive_context>`
      // blocks — is handled by metadata rehydration, not by re-running runtime
      // injection on the fork: the source's live turns persist those blocks onto
      // message metadata, the fork copies that metadata, and
      // `Conversation.loadFromDb` rehydrates them byte-for-byte. The wake never
      // re-runs the injection pipeline, so it needs no interactivity hint here.
      // Profile forcing (model/thinking/effort parity) is a separate concern
      // and stays keyed on `matchConversationProfile` via `matchedProfile`.
      ...(matchedProfile !== undefined
        ? { forceOverrideProfile: matchedProfile }
        : {}),
      personaOverride,
      hintRole: "user",
      skipHintInjection: true,
      suppressAutoCompaction: true,
      // Finalization consumes the window (cursor advance + prior-retro GC)
      // on `invoked: true`, so an empty reply with no usable output must
      // fail the wake and leave the window retryable instead of reading as
      // a successful pass (LUM-3013).
      requireUsableOutput: true,
      // The fork's title already reads "(Retrospective)", so an empty-body
      // "Conversation Woke" surface card on top of it would be noise. Suppress
      // it — clients should display the fork as a normal background conv.
      suppressWakeSurface: true,
    });
    wakeSucceeded = result.invoked;
    failureReason = result.reason;
    wakeExitReason = result.exitReason;
  } catch (err) {
    threw = err;
    failureReason = err instanceof Error ? err.message : String(err);
    log.error(
      { err, forkId, sourceConversationId },
      "memory-retrospective (fork): wake threw",
    );
  }

  if (wakeSucceeded) {
    // Fail-closed finalization: `invoked: true` proves only that the wake
    // went live, not that the run produced anything. The agent loop swallows
    // provider rejections into a normal no-output return, an exhausted output
    // budget can stop a run before any visible text or tool call, and a
    // model may stop mid-review without saving. Advancement past the window
    // therefore requires POSITIVE evidence from THIS run, one of:
    //   - a memory-writing tool call on the fork's post-boundary tail whose
    //     execution verifiably succeeded (matching non-error tool_result), or
    //   - a reviewed-and-nothing-to-save pass: the model ENDED the run by
    //     answering in its own words (its final assistant row carries text),
    //     attempted no memory write at all, and the loop ended because IT
    //     stopped asking for tools rather than because something cut the run
    //     short. A run that attempted a save and failed cannot advance by
    //     talking instead, a run whose narration went live but whose final
    //     response was empty has not concluded, and a run the provider or
    //     the output ceiling ended mid-review has not reviewed its window.
    // The proof of an empty-handed review is the shape of the run, never the
    // wording of the reply: a model that reaches its own end with nothing to
    // write has reviewed the window, in whatever words it says so.
    // The evidence read is run-specific by construction
    // (`loadRetrospectiveRunMessages` scopes to rows after the fork
    // boundary), so a prior run's persisted saves can never satisfy it, and
    // it reads the DB rather than the returned history, so a checkpoint that
    // went live and persisted saves counts even when a later in-loop repair
    // rebased the returned tail. A run with neither evidence kind follows
    // the wake-failure path: cursor, remembered log, and the prior
    // retrospective (the dedup baseline) stay untouched and the window
    // remains retryable.
    const runEvidence = await collectRetrospectiveRunEvidence(forkId);
    const reviewedNoFindings =
      runEvidence.committedTextReply &&
      runEvidence.durableToolAttemptCount === 0 &&
      wakeExitReason === MODEL_DRIVEN_STOP_EXIT_REASON;
    if (runEvidence.durableToolCallCount === 0 && !reviewedNoFindings) {
      log.warn(
        {
          sourceConversationId,
          forkId,
          newMessageCount: newMessages.length,
          durableToolAttempts: runEvidence.durableToolAttemptCount,
          committedTextReply: runEvidence.committedTextReply,
          exitReason: wakeExitReason ?? null,
        },
        "memory-retrospective (fork): run produced neither a verified durable write nor a completed empty-handed review; leaving window retryable",
      );
      failureReason = describeUnusableRun(runEvidence, wakeExitReason);
    } else {
      return await finalizeSuccessfulRetrospective({
        config,
        sourceConversationId,
        retrospectiveConversationId: forkId,
        cutoffMessageId,
        newMessageCount: newMessages.length,
        prior,
        priorRemembers,
        runRemembers: runEvidence.remembers,
        noFindings: reviewedNoFindings,
        logFields: {
          kind: "fork",
          windowStartTimestamp,
          durationMs: Date.now() - startedAtMs,
        },
      });
    }
  }

  // Wake failed or produced no usable output. Bump `lastRunAt` only so the
  // cooldown gate applies, leave `lastProcessedMessageId` alone so the next
  // attempt re-processes the same messages. Then clean up the orphan fork.
  await bumpRetrospectiveLastRunAt(sourceConversationId, Date.now());
  await safeDeleteRetrospectiveConversation(
    forkId,
    FORK_DELETE_FAILURE_WARNING,
  );

  if (threw !== undefined) {
    throw threw;
  }

  if (wakeSucceeded) {
    // Reached only through the evidence gate above, which set `failureReason`
    // to why the run could not consume its window.
    return {
      kind: "no_usable_output",
      reason: failureReason,
      conversationId: forkId,
    };
  }

  return {
    kind: "wake_failed",
    reason: failureReason,
    conversationId: forkId,
  };
}

/**
 * Why a run that went live still could not consume its window, phrased for
 * the job row's `last_error` and the CLI. The distinction it draws is the one
 * an operator needs: a lost memory write reads differently from a review that
 * never reached a conclusion, and the fork is deleted on failure, so this
 * string is what survives the run.
 */
function describeUnusableRun(
  evidence: { durableToolAttemptCount: number; committedTextReply: boolean },
  exitReason: AgentLoopExitReason | undefined,
): string {
  if (evidence.durableToolAttemptCount > 0) {
    return `run attempted ${evidence.durableToolAttemptCount} memory write(s), none of which persisted a successful result`;
  }
  if (!evidence.committedTextReply) {
    return "run committed neither a memory write nor a concluding reply";
  }
  return `run replied without saving anything, but ended on ${exitReason ?? "no terminal exit"} rather than a completed review`;
}

function enqueueFollowUpJobs(): string[] {
  const followUpJobIds: string[] = [];
  for (const jobType of FOLLOW_UP_JOB_TYPES) {
    try {
      followUpJobIds.push(enqueueMemoryJob(jobType, {}));
    } catch (err) {
      log.warn(
        { err, jobType },
        "memory-retrospective: failed to enqueue follow-up job; continuing",
      );
    }
  }
  return followUpJobIds;
}

/**
 * The source-derived parity pins the fork wake runs under: the system-prompt
 * persona override and the tool-resolution context pin. Both exist so the
 * fork's provider request matches what the SOURCE conversation's live turns
 * sent (prompt-cache prefix is `tools → system → messages`).
 */
interface SourceParityPins {
  personaOverride: SystemPromptPersonaOverride;
  toolContextPin: WakeToolContextPin;
}

/**
 * Derive the fork wake's parity pins from the source conversation.
 *
 * Persona slugs — local/desktop sources (`originChannel` null or
 * `"vellum"`): live turns resolve the guardian contact's userFile — either
 * via the undefined-trust-context branch of `resolveUserFilename`
 * (desktop/native, no gateway) or via its guardian-class
 * `findGuardianForChannel("vellum")` fallback (managed desktop, whose
 * JWT-principal `requesterExternalUserId` never matches a contact channel
 * row). `resolveUserSlug(undefined)` reproduces both, falling back to
 * `"default"` exactly as the live prompt build does when no guardian
 * resolves. Channel persona is `"vellum"`. Channel-routed sources: live-turn
 * persona resolution keys off the requester's `requesterExternalUserId`
 * (contact lookup per actor, possibly different across turns), which is not
 * stored on the conversation row — the slugs are omitted so the wake keeps
 * today's persona derivation for them.
 *
 * `hasNoClient` — pinned on BOTH the persona override (kept for prompt-build
 * parity; no system-prompt section branches on the flag, so this pin does not
 * affect prompt output) and the tool-context pin (the live consumer, gating
 * tool availability), using the live-turn derivation: interactive
 * interfaces run their turns with `isInteractive: true` (`hasNoClient` reads
 * `false` for the turn), while channel-routed and chrome-extension turns stay
 * clientless (`true`) — the exact `isInteractiveInterface` predicate
 * `conversation-routes.ts` / `process-message.ts` apply. Pinned explicitly even when it matches the
 * fork's hydrated value (`true`) so the parity contract doesn't depend on
 * hydration defaults.
 *
 * `toolContextPin.transportInterface` — the interface the source's most
 * recent live turns ran on (see {@link resolveSourceLiveInterface}).
 * `toolContextPin.clientOs` is recovered from the same persisted user-message
 * metadata, with the transport interface as a fallback.
 * `channelCapabilities` is left unset: desktop/web HTTP turns never set
 * channel capabilities, and for channel-routed sources (whose live turns do
 * carry them) every tool gate resolves identically under
 * `hasNoClient = true` with or without capabilities — so unset is parity
 * for the former and outcome-equal for the latter.
 */
function resolveSourceParityPins(
  source: Pick<ConversationRow, "id" | "originChannel" | "originInterface">,
  sliceMessages: Array<{ role: string; metadata: string | null }>,
): SourceParityPins {
  const channel = source.originChannel;
  const channelRouted = channel != null && channel !== "vellum";
  const recovered = resolveSourceLiveInterface(source, sliceMessages);
  if (recovered === undefined && !channelRouted) {
    // No per-turn interface stamp and no originInterface, so the pin falls
    // back to "web" below. If the source actually ran on a desktop interface
    // (e.g. macos with host_* tools), those tools won't be reproduced on the
    // fork's wire and tool-surface cache parity will partially miss. Surface
    // it rather than silently miss.
    log.warn(
      {
        conversationId: source.id,
        originInterface: source.originInterface,
        originChannel: source.originChannel,
      },
      "memory-retrospective (fork): source live interface unrecoverable; tool-surface cache parity may miss (defaulting to web)",
    );
  }
  // Non-channel-routed sources always have a client-connected interface;
  // when none is recoverable, default to "web" — the same terminal fallback
  // `resolveTurnInterface` applies to live turns. Channel-routed sources
  // with an unmappable channel stay undefined (their live turns were
  // clientless either way).
  const transportInterface = recovered ?? (channelRouted ? undefined : "web");
  const clientOs = resolveSourceLiveClientOs(sliceMessages, transportInterface);
  const hasNoClient =
    transportInterface == null || !isInteractiveInterface(transportInterface);
  const personaOverride: SystemPromptPersonaOverride = channelRouted
    ? { hasNoClient }
    : {
        userSlug: resolveUserSlug(undefined) ?? "default",
        channelSlug: "vellum",
        hasNoClient,
      };
  return {
    personaOverride,
    // Pin the retrospective origin so the wake's tool calls resolve under it
    // (`buildPolicyContext` → the checker's origin-scoped skill-authoring
    // grant). The grant is independently gated on proc-to-skills being active,
    // so stamping the origin unconditionally is inert when the feature is off.
    toolContextPin: {
      hasNoClient,
      transportInterface,
      clientOs,
      requestOrigin: MEMORY_RETROSPECTIVE_ORIGIN,
    },
  };
}

/**
 * Recover the interface the source conversation's most recent live turns ran
 * on — the transport whose provider requests the fork wants cache parity
 * with.
 *
 * Scans the new-message slice newest-first for a user message stamped with
 * `userMessageInterface` (the same per-message metadata live turns persist),
 * then falls back to the conversation row's `originInterface` (sticky
 * first-interface column), then to the origin channel id where it doubles as
 * an interface id (telegram/slack/whatsapp/email/phone; the legacy
 * `"vellum"` alias maps to `"web"`). Every input is persisted state, so for
 * a given cutoff the result is deterministic — it cannot flap between
 * retries of the same slice.
 */
function resolveSourceLiveInterface(
  source: Pick<ConversationRow, "originChannel" | "originInterface">,
  sliceMessages: Array<{ role: string; metadata: string | null }>,
): InterfaceId | undefined {
  for (let i = sliceMessages.length - 1; i >= 0; i--) {
    const row = sliceMessages[i]!;
    if (row.role !== "user" || !row.metadata) {
      continue;
    }
    let meta: unknown;
    try {
      meta = JSON.parse(row.metadata);
    } catch {
      continue;
    }
    if (!meta || typeof meta !== "object") {
      continue;
    }
    const iface = parseInterfaceId(
      (meta as Record<string, unknown>).userMessageInterface,
    );
    if (iface) {
      return iface;
    }
  }
  return (
    parseInterfaceId(source.originInterface) ??
    parseInterfaceId(source.originChannel) ??
    undefined
  );
}

/** Pin the source's live client OS so OS-gated tools match on wake. */
function resolveSourceLiveClientOs(
  sliceMessages: Array<{ role: string; metadata: string | null }>,
  transportInterface: InterfaceId | undefined,
): ClientOs | undefined {
  for (let i = sliceMessages.length - 1; i >= 0; i--) {
    const row = sliceMessages[i]!;
    if (row.role !== "user" || !row.metadata) {
      continue;
    }
    let meta: unknown;
    try {
      meta = JSON.parse(row.metadata);
    } catch {
      continue;
    }
    if (!meta || typeof meta !== "object") {
      continue;
    }
    const { clientOsFromRequest, client } = meta as Record<string, unknown>;
    if (clientOsFromRequest !== true || !client || typeof client !== "object") {
      continue;
    }
    const clientOs = parseClientOs((client as Record<string, unknown>).os);
    if (clientOs) {
      return clientOs;
    }
  }
  return parseClientOs(transportInterface) ?? undefined;
}

type PriorRetrospective = NonNullable<
  ReturnType<typeof findMostRecentRetrospectiveFor>
>;

/**
 * Locate the most recent prior retrospective and assemble the
 * `<already_remembered>` dedup baseline (persisted cumulative log, falling
 * back to scanning the prior). Callers must invoke this BEFORE creating this
 * run's own retrospective conversation — otherwise the lookup could locate
 * it. The prior row is returned so the success path can GC it once this run
 * supersedes it.
 */
async function resolvePriorRetrospective(
  sourceConversationId: string,
  rememberedLog: string[],
): Promise<{ prior: PriorRetrospective | null; priorRemembers: string[] }> {
  const prior = findMostRecentRetrospectiveFor(sourceConversationId);
  return {
    prior,
    priorRemembers: await collectPriorRetrospectiveRemembers(
      prior,
      rememberedLog,
    ),
  };
}

/**
 * Success bookkeeping shared by both handlers. Extracts this run's saves
 * from its own retrospective conversation FIRST — the wake's tail (including
 * `remember` tool_use blocks) is persisted by the time
 * `wakeAgentForOpportunity` returns, and extraction must precede any
 * cleanup. `priorRemembers` (cumulative log, or the prior-conversation scan
 * that seeds it) is the base so the prior's saves survive its GC below.
 */
async function finalizeSuccessfulRetrospective(args: {
  config: AssistantConfig;
  sourceConversationId: string;
  retrospectiveConversationId: string;
  cutoffMessageId: string;
  newMessageCount: number;
  prior: PriorRetrospective | null;
  priorRemembers: string[];
  /**
   * The `remember` contents extracted from this run's persisted tail by the
   * caller's usable-output check; passed through so the evidence that gated
   * advancement is exactly the evidence folded into the log.
   */
  runRemembers: string[];
  /** Whether the run advanced on a reviewed-and-nothing-to-save pass. */
  noFindings: boolean;
  /** Per-kind extras for the success log line (e.g. `kind`, fork anchor). */
  logFields: Record<string, unknown>;
}): Promise<MemoryRetrospectiveOutcome> {
  const {
    config,
    sourceConversationId,
    retrospectiveConversationId,
    cutoffMessageId,
    newMessageCount,
    prior,
    priorRemembers,
    runRemembers,
    noFindings,
    logFields,
  } = args;

  await upsertRetrospectiveState({
    conversationId: sourceConversationId,
    lastProcessedMessageId: cutoffMessageId,
    lastRunAt: Date.now(),
    rememberedLog: appendToRememberedLog(priorRemembers, runRemembers),
  });

  // Skill cards are not a finalize concern: when the run authors a skill, the
  // scaffold executor enqueues the durable `skill_card_insert` delivery job at
  // the creation site (see `executeScaffoldManagedSkill` and
  // `memory-retrospective-skill-card.ts`), so the GC below can never destroy
  // the card's inputs.

  await deleteSupersededPriorRetrospective(config, prior, sourceConversationId);

  const followUpJobIds = enqueueFollowUpJobs();

  log.info(
    {
      sourceConversationId,
      backgroundConversationId: retrospectiveConversationId,
      cutoffMessageId,
      newMessageCount,
      priorRememberCount: priorRemembers.length,
      noFindings,
      ...logFields,
    },
    "memory-retrospective invoked",
  );
  return {
    kind: "invoked",
    backgroundConversationId: retrospectiveConversationId,
    cutoffMessageId,
    newMessageCount,
    followUpJobIds,
    noFindings,
  };
}

const FORK_DELETE_FAILURE_WARNING =
  "memory-retrospective (fork): failed to delete fork on failure; continuing";

/**
 * Best-effort cleanup of this run's own retrospective conversation on a
 * failure path. Deletion failure is logged with the caller-supplied warning
 * and never escalates.
 */
async function safeDeleteRetrospectiveConversation(
  conversationId: string,
  warnMessage: string,
): Promise<void> {
  try {
    await deleteConversation(conversationId);
  } catch (err) {
    log.warn({ err, conversationId }, warnMessage);
  }
}

/**
 * GC the prior retrospective conversation once a newer run has succeeded.
 * The persisted `remembered_log` on `memory_retrospective_state` is the
 * dedup baseline (the most-recent run is scanned only as a fallback for
 * state rows that predate the log column), and the success path has already
 * folded the prior's saves into the log — so the superseded run is dead
 * weight. Fork-kind runs each materialize a full copy of the source
 * conversation's message rows, so without GC a long-lived daemon accumulates
 * one full-history copy per retrospective interval per active conversation.
 *
 * Only deletes a prior the source conversation actually owns:
 * `findMostRecentRetrospectiveFor` walks up the fork chain, so when the
 * source is a user-created fork with no retrospectives of its own, the prior
 * belongs to an ANCESTOR conversation. That row is the ancestor's preserved
 * dedup-baseline fallback — deleting it could force the ancestor's next
 * retrospective to re-save facts its prior passes already captured.
 *
 * Called only AFTER `upsertRetrospectiveState` on the success path: deleting
 * on failure would break the dedup chain (the failed run's conversation is
 * cleaned up separately and the prior must remain the most-recent
 * retrospective for the retry). Best-effort — deletion failure is logged and
 * never fails the job. Operators opt out of GC entirely via
 * `memory.retrospective.keepSupersededRuns`.
 */
async function deleteSupersededPriorRetrospective(
  config: AssistantConfig,
  prior: PriorRetrospective | null,
  sourceConversationId: string,
): Promise<void> {
  if (!prior) {
    return;
  }
  if (config.memory.retrospective.keepSupersededRuns) {
    return;
  }
  if (prior.forkParentConversationId !== sourceConversationId) {
    return;
  }
  try {
    // Fork-kind priors carry a full copy of the source's message history, so
    // delete the message rows off the event loop in lock-friendly batches —
    // the deletion mirror of the batched fork copy that built them — instead
    // of one lock-holding transaction that would starve live user turns.
    await deleteConversation(prior.id);
  } catch (err) {
    log.warn(
      { err, priorConversationId: prior.id },
      "memory-retrospective: failed to delete superseded prior retrospective conversation; continuing",
    );
  }
}

/**
 * Walk the slice and return the `<turn_context>` `current_time:` value from
 * the first user message that carries one. Injected blocks like
 * `<turn_context>` are NOT persisted in message content — they live in
 * message metadata (the `turnContextBlock` key, the same one the
 * conversation rehydrator in `daemon/conversation.ts` reads) and are
 * re-injected into content at load time, so this reads metadata, not
 * content. The agent uses the value as the explicit anchor for the review
 * window inside its forked history.
 */
function findFirstTurnContextTimestamp(
  messages: Array<{ role: string; metadata: string | null }>,
): string | null {
  for (const row of messages) {
    if (row.role !== "user" || !row.metadata) {
      continue;
    }
    let meta: unknown;
    try {
      meta = JSON.parse(row.metadata);
    } catch {
      continue;
    }
    if (!meta || typeof meta !== "object") {
      continue;
    }
    const block = (meta as Record<string, unknown>).turnContextBlock;
    if (typeof block !== "string") {
      continue;
    }
    // Reuse the compactor's parser by wrapping the metadata block text in a
    // single-text-block message — same `<turn_context>` / `current_time:`
    // scan it applies to rehydrated content.
    const ts = extractTurnContextTimestamp({
      role: "user",
      content: [{ type: "text", text: block }],
    });
    if (ts) {
      return ts;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prior-retrospective remember extraction
// ---------------------------------------------------------------------------

/**
 * Assemble the `<already_remembered>` dedup baseline for a run.
 *
 * Prefers the persisted cumulative `rememberedLog` from the source
 * conversation's state row — it spans every pass the cap retains and
 * survives GC of superseded retrospective conversations. Falls back to
 * scanning the prior retrospective conversation (located by the caller via
 * `findMostRecentRetrospectiveFor` — the caller keeps the id so it can GC
 * the prior run after success) for state rows that predate the log column
 * or whose log is empty. Empty array on first run (no log, no prior).
 */
async function collectPriorRetrospectiveRemembers(
  prior: { id: string } | null,
  rememberedLog: string[],
): Promise<string[]> {
  if (rememberedLog.length > 0) {
    return rememberedLog;
  }
  if (!prior) {
    return [];
  }
  return await extractRetrospectiveRunRemembers(prior.id);
}

/**
 * Pull the `content` strings out of every `remember` tool call made by a
 * retrospective run's own work in the given retrospective conversation.
 * `loadRetrospectiveRunMessages` scopes fork-kind rows to the post-fork tail
 * (the copied prefix contains the source conversation's own inline
 * `remember` calls, which must not pollute the dedup baseline) and returns
 * `null` on load failure (logged, never fatal) — treated here as "the run
 * saved nothing".
 */
async function extractRetrospectiveRunRemembers(
  conversationId: string,
): Promise<string[]> {
  const conv = await getConversation(conversationId);
  const runMessages = await loadRetrospectiveRunMessages(
    conversationId,
    conv?.source ?? null,
  );
  if (runMessages == null) {
    return [];
  }
  // Deliberately unfiltered by execution success: this reads a PRIOR run for
  // the <already_remembered> dedup baseline, where over-inclusion is the
  // safe direction (worst case a fact is not re-saved) and old runs predate
  // result-verified evidence. The CURRENT run's log append goes through
  // `collectRetrospectiveRunEvidence`, which does verify execution.
  return extractRememberContents(runMessages);
}

/**
 * Tool names whose persisted `tool_use` blocks count as durable memory work
 * for the fail-closed advancement gate: `remember` writes the memory buffer,
 * `scaffold_managed_skill` writes a managed skill. Read-only tools on the
 * retrospective allowlist (`skill_load`, `find_similar_skills`) deliberately
 * do not qualify: a run that only browsed produced nothing durable.
 */
const DURABLE_RETROSPECTIVE_TOOLS: ReadonlySet<string> = new Set([
  "remember",
  "scaffold_managed_skill",
]);

/**
 * Read the durable evidence a retrospective run persisted: its `remember`
 * contents plus a count of every memory-writing tool call on the run's
 * post-boundary tail whose EXECUTION succeeded. A `tool_use` block alone
 * proves only that the model asked; the durable write happens inside the
 * executor, so a call counts (and its facts feed the remembered log) only
 * when a matching non-error `tool_result` is persisted on the same tail. A
 * failed or missing execution therefore leaves the window retryable, and a
 * failed `remember`'s facts never enter the `<already_remembered>` baseline
 * where they would suppress the retry's re-save. A load failure
 * (`runMessages == null`) reports zero durable calls, which the advancement
 * gate treats as "not proven usable" (fail-closed).
 */
async function collectRetrospectiveRunEvidence(
  conversationId: string,
): Promise<{
  remembers: string[];
  /** Memory-writing tool calls whose execution verifiably succeeded. */
  durableToolCallCount: number;
  /** Memory-writing tool calls the run attempted, regardless of outcome. */
  durableToolAttemptCount: number;
  /**
   * The run ENDED by answering in its own words: the last persisted
   * assistant row carries a text block with non-whitespace content. Any
   * wording qualifies, so a pass that found nothing durable proves it
   * reviewed the window by replying, not by reproducing a phrase; but the
   * reply must be the run's final word, so narration followed by an empty
   * last response does not qualify.
   */
  committedTextReply: boolean;
}> {
  const conv = await getConversation(conversationId);
  const runMessages = await loadRetrospectiveRunMessages(
    conversationId,
    conv?.source ?? null,
  );
  if (runMessages == null) {
    return {
      remembers: [],
      durableToolCallCount: 0,
      durableToolAttemptCount: 0,
      committedTextReply: false,
    };
  }
  const succeededIds = collectSuccessfulToolResultIds(runMessages);
  return {
    remembers: extractRememberContents(runMessages, succeededIds),
    durableToolCallCount: countDurableToolUses(runMessages, succeededIds),
    durableToolAttemptCount: countDurableToolUses(runMessages, null),
    committedTextReply: hasCommittedTextReply(runMessages),
  };
}

/**
 * Whether the LAST persisted assistant row on the run's tail carries a text
 * block with non-whitespace content. Paired with a model-driven stop and
 * zero memory-write attempts, that closing reply is the persisted artifact
 * of a pass that read its window and had nothing to save: the model spoke
 * and then chose to end the run. Reading only the final row separates it
 * from a run whose narration went live but whose actual conclusion was
 * empty, as well as from a response that committed nothing at all
 * (thinking-only output, an empty content array).
 */
function hasCommittedTextReply(messages: MessageLike[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") {
      continue;
    }
    const blocks = parseMessageBlocks(msg);
    if (blocks === null) {
      return false;
    }
    return blocks.some(
      (b) =>
        b.type === "text" && typeof b.text === "string" && b.text.trim() !== "",
    );
  }
  return false;
}

/**
 * Ids of `tool_result` blocks on the run's user rows whose execution did not
 * report an error. Robust to malformed content JSON the same way
 * `extractRememberContents` is.
 */
function collectSuccessfulToolResultIds(messages: MessageLike[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "user") {
      continue;
    }
    for (const b of parseMessageBlocks(msg) ?? []) {
      // guard:allow-tool-result-only: success evidence for locally-executed
      // durable memory tools; server-side web_search_tool_result never
      // corresponds to a durable write and carries no is_error flag.
      if (
        b.type === "tool_result" &&
        typeof b.tool_use_id === "string" &&
        b.is_error !== true
      ) {
        ids.add(b.tool_use_id);
      }
    }
  }
  return ids;
}

/**
 * Count persisted `tool_use` blocks whose `name` is in
 * {@link DURABLE_RETROSPECTIVE_TOOLS} across the run's assistant rows.
 * With a `succeededIds` set, only calls whose id has a matching successful
 * `tool_result` count (verified executions); with `null`, every attempt
 * counts regardless of outcome.
 */
function countDurableToolUses(
  messages: MessageLike[],
  succeededIds: ReadonlySet<string> | null,
): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant") {
      continue;
    }
    for (const b of parseMessageBlocks(msg) ?? []) {
      if (
        b.type === "tool_use" &&
        DURABLE_RETROSPECTIVE_TOOLS.has(String(b.name)) &&
        (succeededIds === null ||
          (typeof b.id === "string" && succeededIds.has(b.id)))
      ) {
        count += 1;
      }
    }
  }
  return count;
}

interface MessageLike {
  role: string;
  content: string | ContentBlock[];
}

/**
 * Parse a message row's content into its block objects, or `null` when the
 * content is malformed (unparseable JSON, not an array). Non-object entries
 * are dropped. Every evidence reader in this module goes through this so
 * malformed rows degrade the same way everywhere: skipped, not propagated.
 */
function parseMessageBlocks(
  msg: MessageLike,
): Record<string, unknown>[] | null {
  let blocks: unknown = msg.content;
  if (typeof blocks === "string") {
    try {
      blocks = JSON.parse(blocks);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(blocks)) {
    return null;
  }
  return blocks.filter(
    (block): block is Record<string, unknown> =>
      typeof block === "object" && block !== null,
  );
}

/**
 * Scan an array of message rows for `tool_use` blocks where `name` is
 * `"remember"` and return the `input.content` strings in order. Robust to
 * malformed content JSON — unparseable rows are skipped, not propagated.
 */
function extractRememberContents(
  messages: MessageLike[],
  succeededIds?: ReadonlySet<string>,
): string[] {
  const contents: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") {
      continue;
    }
    for (const b of parseMessageBlocks(msg) ?? []) {
      if (b.type !== "tool_use") {
        continue;
      }
      if (b.name !== "remember") {
        continue;
      }
      // When a success set is provided, only executions that reported a
      // non-error tool_result contribute facts: a failed remember never
      // wrote the buffer, and logging its facts would suppress the retry's
      // re-save via <already_remembered>.
      if (
        succeededIds !== undefined &&
        (typeof b.id !== "string" || !succeededIds.has(b.id))
      ) {
        continue;
      }
      const input = b.input;
      if (!input || typeof input !== "object") {
        continue;
      }
      const content = (input as Record<string, unknown>).content;
      // `remember` accepts a single string or an array of facts (batch form);
      // flatten both so batched saves still feed the dedup baseline.
      const facts = Array.isArray(content) ? content : [content];
      for (const fact of facts) {
        if (typeof fact !== "string") {
          continue;
        }
        const trimmed = fact.trim();
        if (trimmed.length > 0) {
          contents.push(trimmed);
        }
      }
    }
  }
  return contents;
}
