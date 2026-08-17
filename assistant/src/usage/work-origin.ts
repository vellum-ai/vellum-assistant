import { LLMCallSiteEnum } from "../config/schemas/llm.js";

/**
 * Coarse attribution of *why* an LLM call happened, derived from the durable
 * usage row's conversation metadata and call site. One bucket per call; the
 * buckets are mutually exclusive by construction (see
 * {@link classifyWorkOrigin}).
 *
 * - `delegated_child`: the call's conversation was spawned by another
 *   conversation (subagent spawn, or a retrospective fork). Its cost belongs
 *   to the delegating turn, captured by the row's parent linkage. Recognized
 *   by a resolved parent conversation id, or, when the spawning conversation
 *   was deleted before the usage batch flushed (fork GC, user deletion) and
 *   the linkage is unresolvable, by the record-time conversation source
 *   ({@link SPAWNED_CONVERSATION_SOURCES}).
 * - `user_created_schedule`: a user-created schedule fired the work, either
 *   on its cron trigger (a `scheduled` conversation) or through a manual run
 *   (a conversation bootstrapped with source `schedule`).
 * - `user_created_background`: background work a user explicitly asked for.
 *   An allowlist ({@link USER_CREATED_BACKGROUND_SOURCES} plus a `background`
 *   conversation the user created), never a residual: a bucket that reads as
 *   user-driven must only hold work that is.
 * - `heartbeat`: the periodic heartbeat agent.
 * - `memory_maintenance`: memory extraction / consolidation / retrieval /
 *   filing / recall upkeep, whether it runs inside a user conversation
 *   (in-turn recall) or detached from any conversation.
 * - `user_interactive`: a standard conversation the user is present in,
 *   opened from any surface (the app, a Home feed item, imported history, or
 *   a messaging channel).
 * - `other_system`: system work with no user-facing conversation behind it,
 *   either an explicitly system-owned conversation source
 *   ({@link OTHER_SYSTEM_SOURCES}) or a recognized call site running with no
 *   conversation at all (title generation, commit messages, and similar).
 * - `unknown`: nothing attributable. Unrecognized conversation kinds, legacy
 *   or ambiguous sources, and plugin-supplied sources land here on purpose,
 *   where they stay visible instead of inflating a named bucket.
 */
export type WorkOrigin =
  | "delegated_child"
  | "user_created_schedule"
  | "user_created_background"
  | "heartbeat"
  | "memory_maintenance"
  | "user_interactive"
  | "other_system"
  | "unknown";

/**
 * Every set below holds persisted `conversations.source` values as string
 * literals rather than imports. Historical usage rows carry these exact
 * strings whatever the stamping code does later, and some of the stamping
 * code lives inside plugins (`plugins/defaults/memory/`) that host code must
 * not import across the plugin boundary. The classifier tests pin them.
 */

/**
 * Sources stamped on conversations another conversation delegated to: a
 * subagent spawn (advisor consults share the subagent source) and both kinds
 * of memory retrospective fork. These conversations carry parent linkage
 * while their spawning conversation exists, so the parent id normally
 * settles them. This set is the recovery path for a spawning conversation
 * deleted before the usage batch flushed: the linkage is gone, the
 * record-time source survives on the usage row and still denotes delegated
 * work.
 */
const SPAWNED_CONVERSATION_SOURCES: ReadonlySet<string> = new Set([
  "subagent",
  "memory-retrospective",
  "memory-retrospective-fork",
]);

/**
 * Call sites whose work is memory maintenance regardless of the conversation
 * (or absence of one) they run in. `recall` fires inside ordinary user turns;
 * the consolidation / extraction / migration / sweep sites run detached from
 * any conversation.
 */
const MEMORY_MAINTENANCE_CALL_SITES: ReadonlySet<string> = new Set([
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

/**
 * Conversation sources owned by memory upkeep jobs. `filing` is the memory v1
 * filing job; `memory` is a legacy persisted source; `memory_v2_consolidation`
 * is the v2 background consolidation run.
 */
const MEMORY_MAINTENANCE_SOURCES: ReadonlySet<string> = new Set([
  "memory_v2_consolidation",
  "filing",
  "memory",
]);

/**
 * Sources of background work a user explicitly created: a watcher they set up
 * and a sequence they queued.
 */
const USER_CREATED_BACKGROUND_SOURCES: ReadonlySet<string> = new Set([
  "watcher",
  "sequence",
]);

/**
 * Sources of system-owned conversations with no user request behind them:
 * `notification` marks the delivery conversations paired with a notification,
 * `auto-analysis` marks retired ambient analysis rows.
 */
const OTHER_SYSTEM_SOURCES: ReadonlySet<string> = new Set([
  "notification",
  "auto-analysis",
]);

/**
 * Prefix of the source stamped on conversations built from history the user
 * imported (`import:<provider>`) and then chats in.
 */
const IMPORTED_CONVERSATION_SOURCE_PREFIX = "import:";

const RECOGNIZED_CALL_SITES: ReadonlySet<string> = new Set(
  LLMCallSiteEnum.options,
);

/**
 * The record-time conversation metadata (and call site) a usage row carries,
 * as resolved by the telemetry read path. `callSite` is stored free-form: it
 * is matched against {@link LLMCallSiteEnum} rather than assumed valid.
 */
export interface WorkOriginInput {
  /** `conversations.conversation_type`: `"standard"` / `"background"` / `"scheduled"`, or null when the call has no conversation. */
  conversationType: string | null;
  /** `conversations.source`, e.g. `"user"`, `"subagent"`, `"schedule"`, or null when the call has no conversation. */
  conversationSource: string | null;
  /** The call site that produced the LLM request, or null when unattributed. */
  callSite: string | null;
  /** Resolved spawning conversation id (subagent parent, or fork parent); null when the conversation was not spawned by another. */
  parentConversationId: string | null;
}

/**
 * Classify a usage row's {@link WorkOrigin} from its record-time conversation
 * metadata and call site. Pure and total: every input maps to exactly one
 * bucket, falling through to `unknown` when nothing is attributable.
 *
 * Precedence (highest first), so overlapping signals resolve deterministically:
 *   1. parent linkage: delegated work is billed to the delegating turn,
 *   2. a spawn source, recovering delegation when the spawning conversation
 *      was deleted before flush,
 *   3. schedule origin, by conversation type or by the `schedule` source a
 *      manual run stamps,
 *   4. heartbeat, by call site or by source,
 *   5. memory maintenance, by call site or by source, so in-turn recall is
 *      billed as upkeep rather than as the user's chat,
 *   6. a standard conversation the user is chatting in,
 *   7. background work the user explicitly created,
 *   8. a system-owned conversation source,
 *   9. a recognized call site with no conversation behind it,
 *  10. `unknown`.
 *
 * Rules 6 to 9 are allowlists. Nothing here may become a residual that
 * absorbs unrecognized combinations: an unnamed kind of work belongs in
 * `unknown`, where it is visible, not in a bucket whose name asserts a cause
 * nobody verified.
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
  if (
    conversationSource !== null &&
    SPAWNED_CONVERSATION_SOURCES.has(conversationSource)
  ) {
    return "delegated_child";
  }
  if (conversationType === "scheduled" || conversationSource === "schedule") {
    return "user_created_schedule";
  }
  if (callSite === "heartbeatAgent" || conversationSource === "heartbeat") {
    return "heartbeat";
  }
  if (
    (callSite !== null && MEMORY_MAINTENANCE_CALL_SITES.has(callSite)) ||
    (conversationSource !== null &&
      MEMORY_MAINTENANCE_SOURCES.has(conversationSource))
  ) {
    return "memory_maintenance";
  }
  if (
    conversationType === "standard" &&
    conversationSource !== null &&
    (conversationSource === "user" ||
      conversationSource === "home-feed" ||
      conversationSource.startsWith(IMPORTED_CONVERSATION_SOURCE_PREFIX))
  ) {
    return "user_interactive";
  }
  if (
    (conversationType === "background" && conversationSource === "user") ||
    (conversationSource !== null &&
      USER_CREATED_BACKGROUND_SOURCES.has(conversationSource))
  ) {
    return "user_created_background";
  }
  if (
    conversationSource !== null &&
    OTHER_SYSTEM_SOURCES.has(conversationSource)
  ) {
    return "other_system";
  }
  if (
    conversationType === null &&
    conversationSource === null &&
    callSite !== null &&
    RECOGNIZED_CALL_SITES.has(callSite)
  ) {
    return "other_system";
  }
  return "unknown";
}
