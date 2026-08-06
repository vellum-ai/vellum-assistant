/**
 * Can a subagent entry address its own detail fetch?
 *
 * One rule, one spelling, shared by every caller that has to answer it: the
 * store (arming a stub for backfill, resolving the fetch), the conversation
 * auto-fetch, and the detail panel's open-fetch. They previously each spelled
 * their own variant, which is how a stub armed with only a parent conversation
 * id ended up fetchable by one and invisible to another.
 */

import { supportsSubagentDetailSelfLookup } from "@/lib/backwards-compat/subagent-detail-self-lookup";

/** The two id fields a detail fetch can be addressed with. */
export interface SubagentDetailAddress {
  /** The subagent's own conversation id. */
  conversationId?: string;
  /** The conversation whose turn spawned it. */
  parentConversationId?: string;
}

/**
 * The conversation id a detail fetch for `entry` must query, or `undefined`
 * when nothing at hand can address it.
 *
 * The child id works on every daemon. A stub recovered without its
 * `subagent_spawned` may only know the parent conversation: 0.11.0+ daemons
 * resolve the subagent's own conversation and treat this parameter as a
 * fallback, so the parent id is a harmless wire placeholder there. An older
 * daemon would trust it verbatim and parse the parent's messages as the
 * subagent's, so below that version a parent-only entry is unaddressable.
 */
export function resolveSubagentDetailConversationId(
  entry: SubagentDetailAddress,
): string | undefined {
  if (entry.conversationId) {
    return entry.conversationId;
  }
  if (entry.parentConversationId && supportsSubagentDetailSelfLookup()) {
    return entry.parentConversationId;
  }
  return undefined;
}

/** Whether a detail fetch for `entry` can be addressed at all. */
export function canAddressSubagentDetail(entry: SubagentDetailAddress): boolean {
  return resolveSubagentDetailConversationId(entry) !== undefined;
}
