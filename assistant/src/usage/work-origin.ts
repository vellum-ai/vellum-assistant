import { type LLMCallSite, LLMCallSiteEnum } from "../config/schemas/llm.js";

/**
 * Coarse attribution of *why* an LLM call happened, derived from the durable
 * usage row's conversation metadata and call site. One bucket per call; the
 * discriminants are mutually exclusive by construction (see
 * {@link classifyWorkOrigin}).
 *
 * - `delegated_child` — the call's conversation was spawned by another
 *   conversation (subagent spawn, or a retrospective fork whose parent is
 *   resolved via `fork_parent_conversation_id`). Its cost belongs to the
 *   delegating turn, captured by the row's `parent_conversation_id` /
 *   `parent_turn_index`. Recognized by real parent linkage, or — when the
 *   spawning conversation was deleted before the usage batch flushed (fork
 *   GC, user deletion), leaving the linkage unresolvable — by the
 *   record-time `conversation_source` still marking it as spawned work
 *   ({@link SPAWNED_CONVERSATION_SOURCES}).
 * - `user_created_schedule` — a user-created schedule fired the work.
 * - `heartbeat` — the periodic heartbeat agent.
 * - `memory_maintenance` — memory extraction / consolidation / retrieval /
 *   recall work not tied to a delegating parent (in-conversation recall,
 *   standalone consolidation with no conversation).
 * - `user_interactive` — a standard conversation the user opened themselves.
 * - `user_created_background` — remaining conversation-scoped work that is
 *   neither a plain interactive chat nor delegated/scheduled/memory (e.g. a
 *   background fork).
 * - `other_system` — a recognized system call site with no conversation to
 *   key off (e.g. a title backfill whose conversation was deleted).
 * - `unknown` — nothing to attribute from: no conversation and no recognized
 *   call site.
 */
export type WorkOrigin =
  | "delegated_child"
  | "user_created_schedule"
  | "heartbeat"
  | "memory_maintenance"
  | "user_interactive"
  | "user_created_background"
  | "other_system"
  | "unknown";

/**
 * Call sites whose work is memory maintenance regardless of the conversation
 * (or absence of one) it runs in. `recall` fires inside ordinary user turns;
 * the consolidation / extraction / migration / sweep sites run detached from
 * any conversation.
 */
const MEMORY_MAINTENANCE_CALL_SITES: ReadonlySet<LLMCallSite> = new Set([
  "memoryExtraction",
  "memoryConsolidation",
  "memoryRetrieval",
  "memoryV2Migration",
  "memoryV2Sweep",
  "memoryRouter",
  "memoryV3SelectL2",
  "memoryV2Consolidation",
  "memoryRetrospective",
  "recall",
]);

const RECOGNIZED_CALL_SITES: ReadonlySet<string> = new Set(
  LLMCallSiteEnum.options,
);

/**
 * `conversations.source` values the daemon stamps at spawn time on
 * conversations that another conversation delegated to — a subagent spawn (or
 * advisor consult, which shares the subagent source) and both kinds of memory
 * retrospective (each forked from a source conversation via
 * `fork_parent_conversation_id`). These conversations always carry parent
 * linkage while their spawning conversation exists, so the row's
 * `parentConversationId` normally settles them as `delegated_child`. This set
 * is the recovery path for when that conversation was deleted before the
 * usage batch flushed: the linkage is gone, but the record-time source
 * survives on the usage row and still mechanically denotes delegated work.
 *
 * The values are literals, not imports: each is a persisted `conversations.
 * source` value stamped at conversation creation (`subagent/manager.ts`;
 * the memory plugin's retrospective job), so historical usage rows carry
 * these exact strings regardless of how the stamping code evolves — and host
 * code must not import a plugin's internals. The classifier tests pin them.
 */
const SPAWNED_CONVERSATION_SOURCES: ReadonlySet<string> = new Set([
  "subagent",
  "memory-retrospective",
  "memory-retrospective-fork",
]);

/**
 * The record-time conversation metadata (and call site) a usage row carries,
 * as resolved by the telemetry read path. `callSite` is stored free-form —
 * it is matched against {@link LLMCallSiteEnum} rather than assumed valid.
 */
export interface WorkOriginInput {
  /** `conversations.conversation_type` — `"standard"` / `"background"` / `"scheduled"`, or null when the call has no conversation. */
  conversationType: string | null;
  /** `conversations.source` — e.g. `"user"`, `"subagent"`, `"schedule"`, `"memory-retrospective"`, or null when the call has no conversation. */
  conversationSource: string | null;
  /** The call site that produced the LLM request, or null when unattributed. */
  callSite: string | null;
  /** Resolved spawning conversation id (subagent parent, or background-fork parent); null when the conversation was not spawned by another. */
  parentConversationId: string | null;
}

/**
 * Classify a usage row's {@link WorkOrigin} from its record-time conversation
 * metadata and call site. Pure and total — every input maps to exactly one
 * bucket, falling through to `unknown` when nothing is attributable.
 *
 * Precedence (highest first), so overlapping signals resolve deterministically:
 *   1. spawned/delegated conversation, recognized by EITHER real parent
 *      linkage OR — when the spawning conversation was deleted before flush —
 *      a record-time source that marks spawned work
 *      ({@link SPAWNED_CONVERSATION_SOURCES}). Both take precedence over the
 *      call site, so a retrospective fork's memory work is attributed to its
 *      delegating turn rather than the memory-maintenance bucket even after
 *      the fork is GC'd,
 *   2. scheduled conversation (by type, or by the "schedule" source a
 *      manually-triggered run stamps without a conversation type),
 *   3. heartbeat / memory-maintenance call sites (dedicated system origins that
 *      run with or without a conversation),
 *   4. standard conversation the user created,
 *   5. any remaining conversation-scoped work,
 *   6. recognized call site with no conversation,
 *   7. nothing to key off.
 */
export function classifyWorkOrigin(input: WorkOriginInput): WorkOrigin {
  const {
    conversationType,
    conversationSource,
    callSite,
    parentConversationId,
  } = input;

  if (parentConversationId !== null) {
    return "delegated_child";
  }
  // The spawning conversation was deleted before this batch flushed, so the
  // JOIN that resolves parent linkage misses — but the record-time source
  // stamped on the usage row still mechanically denotes delegated work.
  if (
    conversationSource !== null &&
    SPAWNED_CONVERSATION_SOURCES.has(conversationSource)
  ) {
    return "delegated_child";
  }
  if (conversationType === "scheduled" || conversationSource === "schedule") {
    // A manually-triggered schedule run bootstraps its conversation with
    // source "schedule" but no conversation type, so the source is the only
    // signal that the work is schedule-origin.
    return "user_created_schedule";
  }
  if (callSite === "heartbeatAgent") {
    return "heartbeat";
  }
  if (
    callSite !== null &&
    MEMORY_MAINTENANCE_CALL_SITES.has(callSite as LLMCallSite)
  ) {
    return "memory_maintenance";
  }
  if (conversationType === "standard" && conversationSource === "user") {
    return "user_interactive";
  }
  if (conversationType !== null) {
    return "user_created_background";
  }
  if (callSite !== null && RECOGNIZED_CALL_SITES.has(callSite)) {
    return "other_system";
  }
  return "unknown";
}

/**
 * An immutable, record-time attribution of an in-flight LLM call, carried on
 * the provider send config so the managed-proxy transport can forward it to
 * the billing backend as `X-Vellum-*` headers. Every field is explicitly
 * nullable so a non-conversation auxiliary call stays distinguishable from a
 * conversation-scoped one (null ≠ "unattributed default"). The {@link workOrigin}
 * is the SAME bucket the `llm_usage` telemetry read path derives via
 * {@link classifyWorkOrigin}, so managed billing rows and usage telemetry share
 * one classifier and vocabulary.
 *
 * `turnIndex` is the 1-indexed position of the user turn the call belongs to,
 * matching the `llm_usage` read-path convention. `parentConversationId` /
 * `parentTurnIndex` carry the spawning conversation's linkage for billed
 * descendant attribution (subagent spawns, background forks); null when the
 * conversation was not spawned by another or the linkage is unresolved at send
 * time (the usage telemetry resolves precise parent-turn attribution at flush).
 */
export interface UsageOriginSnapshot {
  conversationType: string | null;
  conversationSource: string | null;
  workOrigin: WorkOrigin | null;
  conversationId: string | null;
  turnIndex: number | null;
  parentConversationId: string | null;
  parentTurnIndex: number | null;
}

/**
 * Build a {@link UsageOriginSnapshot}, deriving {@link UsageOriginSnapshot.workOrigin}
 * from the same {@link classifyWorkOrigin} the usage telemetry uses. Callers pass
 * the record-time conversation metadata and call site; nulls are preserved
 * verbatim so auxiliary (no-conversation) calls stay distinguishable.
 */
export function buildUsageOriginSnapshot(input: {
  conversationType: string | null;
  conversationSource: string | null;
  callSite: string | null;
  conversationId: string | null;
  turnIndex: number | null;
  parentConversationId: string | null;
  parentTurnIndex: number | null;
}): UsageOriginSnapshot {
  return {
    conversationType: input.conversationType,
    conversationSource: input.conversationSource,
    workOrigin: classifyWorkOrigin({
      conversationType: input.conversationType,
      conversationSource: input.conversationSource,
      callSite: input.callSite,
      parentConversationId: input.parentConversationId,
    }),
    conversationId: input.conversationId,
    turnIndex: input.turnIndex,
    parentConversationId: input.parentConversationId,
    parentTurnIndex: input.parentTurnIndex,
  };
}
