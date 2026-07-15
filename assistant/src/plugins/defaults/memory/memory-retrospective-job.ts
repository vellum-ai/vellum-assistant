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
  type ContentBlock,
  type ConversationRow,
  deleteConversation,
  getConversation,
  isConversationProcessing,
} from "@vellumai/plugin-api";

import {
  type InterfaceId,
  isInteractiveInterface,
  parseInterfaceId,
} from "../../../channels/types.js";
import { isProcToSkillsActive } from "../../../config/memory-v3-gate.js";
import type { AssistantConfig } from "../../../config/types.js";
import { getGuardianDelivery } from "../../../contacts/guardian-delivery-reader.js";
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
  upsertMemoryRetrospectiveJob,
} from "../../../persistence/jobs-store.js";
import { resolveUserSlug } from "../../../prompts/persona-resolver.js";
import type { SystemPromptPersonaOverride } from "../../../prompts/system-prompt.js";
import { wakeAgentForOpportunity } from "../../../runtime/agent-wake.js";
import { recordWatchdogEvent } from "../../../telemetry/watchdog-events-store.js";
import { findMostRecentRetrospectiveFor } from "./find-most-recent-retrospective-for.js";
import { getLogger } from "./logging.js";
import { getRetrospectiveMessagesAfter } from "./memory-retrospective-accounting.js";
import {
  MEMORY_RETROSPECTIVE_FORK_SOURCE,
  MEMORY_RETROSPECTIVE_GROUP_ID,
  MEMORY_RETROSPECTIVE_INSTRUCTION_KIND,
  MEMORY_RETROSPECTIVE_ORIGIN,
  MEMORY_RETROSPECTIVE_SOURCE,
} from "./memory-retrospective-constants.js";
import { loadRetrospectiveRunMessages } from "./memory-retrospective-fork-boundary.js";
import { buildForkInstruction } from "./memory-retrospective-prompt.js";
import {
  appendToRememberedLog,
  bumpRetrospectiveLastRunAt,
  getRetrospectiveState,
  upsertRetrospectiveState,
} from "./memory-retrospective-state.js";

const log = getLogger("memory-retrospective-job");

/**
 * Follow-up jobs to fan out after a successful retrospective. Empty for now;
 * declared as a const so future maintenance jobs can be added without
 * touching the handler body.
 */
const FOLLOW_UP_JOB_TYPES: readonly MemoryJobType[] = [] as const;

/**
 * Fallback delay for re-upserting a run that was skipped because the source
 * conversation was mid-turn. The PRIMARY requeue is event-driven: the
 * mid-turn skip leaves `lastRunAt` unbumped, so the message-indexing pass on
 * the turn's final assistant message re-enqueues immediately. This timed row
 * only covers a turn that aborts without ever persisting another message.
 * Each retried attempt re-checks the processing flag and re-upserts at the
 * same cadence, so the loop self-resolves when the turn ends.
 */
export const SOURCE_PROCESSING_REQUEUE_DELAY_MS = 60_000;

/** Watchdog check_name for the per-run retrospective outcome counter. */
const MEMORY_RETROSPECTIVE_RUN_CHECK_NAME = "memory_retrospective_run";

export type MemoryRetrospectiveOutcome =
  | { kind: "disabled" }
  | { kind: "no_new_messages" }
  | { kind: "source_processing" }
  | { kind: "wake_failed"; reason?: string; conversationId?: string }
  | {
      kind: "invoked";
      backgroundConversationId: string;
      cutoffMessageId: string;
      newMessageCount: number;
      followUpJobIds: string[];
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

  // Central health counter (admin analytics groups on the watchdog
  // check_name): one event per run with its outcome kind. A run that
  // throws records outcome "error" before the exception continues to the
  // jobs worker's retry machinery, so a fleet-wide spike in
  // `wake_failed`/`error` (e.g. a provider outage on the retrospective's
  // resolved model) is visible without log access. The emitter itself
  // never throws — the run's outcome must reach the jobs worker
  // regardless.
  const emitRunOutcome = (outcome: string, reason?: string): void => {
    try {
      recordWatchdogEvent({
        checkName: MEMORY_RETROSPECTIVE_RUN_CHECK_NAME,
        value: 1,
        detail: {
          outcome,
          ...(reason ? { reason: reason.slice(0, 200) } : {}),
        },
      });
    } catch {
      // recordWatchdogEvent already no-ops on opt-out and a missing
      // telemetry DB; anything past that is not worth surfacing here.
    }
  };

  let outcome: MemoryRetrospectiveOutcome;
  try {
    outcome = await runForkBasedRetrospective(sourceConversationId, config);
  } catch (err) {
    emitRunOutcome("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  emitRunOutcome(
    outcome.kind,
    outcome.kind === "wake_failed" ? outcome.reason : undefined,
  );
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
  // runs right after the colliding turn completes. Mid-turn attempts are
  // cheap no-ops (existence + processing check) that recur at most once per
  // persisted message and coalesce into a single pending row via the upsert.
  // The timed re-upsert below is a fallback for a turn that aborts without
  // ever indexing another message (the lifecycle/disposal enqueue remains
  // the last-resort net). Both state pointers stay untouched, so nothing is
  // lost. Returning (not throwing) keeps the jobs-worker from
  // retry-with-backoff.
  if (await isConversationProcessing(sourceConversationId)) {
    try {
      upsertMemoryRetrospectiveJob(
        { conversationId: sourceConversationId },
        Date.now() + SOURCE_PROCESSING_REQUEUE_DELAY_MS,
      );
      log.info(
        {
          sourceConversationId,
          requeueDelayMs: SOURCE_PROCESSING_REQUEUE_DELAY_MS,
        },
        "memory-retrospective (fork): source conversation is mid-turn; requeued",
      );
    } catch (err) {
      log.warn(
        { err, sourceConversationId },
        "memory-retrospective (fork): mid-turn fallback requeue failed; relying on the turn-end trigger check",
      );
    }
    return { kind: "source_processing" };
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
  // The fork copies only the source's visible tail and carries the inherited
  // compaction summary on its own row (with a fork-local compacted count of
  // 0). Compacted source ⇒ summary + tail visible to the agent natively.
  let forkConversationRow: Awaited<
    ReturnType<typeof forkConversationForRetrospective>
  >;
  try {
    // Async variant: the source message-row copy runs off the event loop in a
    // sqlite3 subprocess so this background pass cannot freeze the daemon's
    // event loop (health probes / gateway IPC) on a large database.
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

  const procToSkillsActive = isProcToSkillsActive(config);
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
  // Warm the vellum guardian-delivery cache so the sync slug resolution inside
  // resolveSourceParityPins (resolveUserSlug(undefined)) hits a fresh key
  // instead of falling back to "default" on a cold/TTL-expired cache.
  await getGuardianDelivery({ channelTypes: ["vellum"] });
  const { personaOverride, toolContextPin } = resolveSourceParityPins(
    sourceConversation,
    newMessages,
  );

  // `skipHintInjection: true` because the instruction is already a
  // persisted message — the wake's hint sandwich would only duplicate it.
  let wakeSucceeded = false;
  let failureReason: string | undefined;
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
      // The fork's title already reads "(Retrospective)", so an empty-body
      // "Conversation Woke" surface card on top of it would be noise. Suppress
      // it — clients should display the fork as a normal background conv.
      suppressWakeSurface: true,
    });
    wakeSucceeded = result.invoked;
    failureReason = result.reason;
  } catch (err) {
    threw = err;
    failureReason = err instanceof Error ? err.message : String(err);
    log.error(
      { err, forkId, sourceConversationId },
      "memory-retrospective (fork): wake threw",
    );
  }

  if (wakeSucceeded) {
    return await finalizeSuccessfulRetrospective({
      config,
      sourceConversationId,
      retrospectiveConversationId: forkId,
      cutoffMessageId,
      newMessageCount: newMessages.length,
      prior,
      priorRemembers,
      logFields: {
        kind: "fork",
        windowStartTimestamp,
        durationMs: Date.now() - startedAtMs,
      },
    });
  }

  // Wake failed. Bump `lastRunAt` only so the cooldown gate applies, leave
  // `lastProcessedMessageId` alone so the next attempt re-processes the
  // same messages. Then clean up the orphan fork.
  await bumpRetrospectiveLastRunAt(sourceConversationId, Date.now());
  await safeDeleteRetrospectiveConversation(
    forkId,
    FORK_DELETE_FAILURE_WARNING,
  );

  if (threw !== undefined) {
    throw threw;
  }

  return {
    kind: "wake_failed",
    reason: failureReason,
    conversationId: forkId,
  };
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
 * interfaces run `updateClient(_, false)` (`hasNoClient = false`), while
 * channel-routed and chrome-extension turns stay clientless (`true`) — the
 * exact `isInteractiveInterface` predicate `conversation-routes.ts` /
 * `process-message.ts` apply. Pinned explicitly even when it matches the
 * fork's hydrated value (`true`) so the parity contract doesn't depend on
 * hydration defaults.
 *
 * `toolContextPin.transportInterface` — the interface the source's most
 * recent live turns ran on (see {@link resolveSourceLiveInterface}).
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
    logFields,
  } = args;

  const runRemembers = await extractRetrospectiveRunRemembers(
    retrospectiveConversationId,
  );
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
  return extractRememberContents(runMessages);
}

interface MessageLike {
  role: string;
  content: string | ContentBlock[];
}

/**
 * Scan an array of message rows for `tool_use` blocks where `name` is
 * `"remember"` and return the `input.content` strings in order. Robust to
 * malformed content JSON — unparseable rows are skipped, not propagated.
 */
function extractRememberContents(messages: MessageLike[]): string[] {
  const contents: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") {
      continue;
    }
    let blocks: unknown = msg.content;
    if (typeof blocks === "string") {
      try {
        blocks = JSON.parse(blocks);
      } catch {
        continue;
      }
    }
    if (!Array.isArray(blocks)) {
      continue;
    }
    for (const block of blocks) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use") {
        continue;
      }
      if (b.name !== "remember") {
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
