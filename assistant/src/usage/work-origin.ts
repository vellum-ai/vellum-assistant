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
 *   `parent_turn_index`.
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
 *   1. spawned/delegated conversation (parent linkage wins over the call site,
 *      so a retrospective fork's memory work is attributed to its delegating
 *      turn rather than the memory-maintenance bucket),
 *   2. scheduled conversation,
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
  if (conversationType === "scheduled") {
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
