/**
 * Trust context resolved during inbound message processing.
 *
 * Extracted from conversation-runtime-assembly.ts to break circular
 * imports (memory/conversation-crud → daemon/conversation-runtime-assembly).
 */
import type { ChannelId } from "../channels/types.js";

export interface TrustContext {
  /** Channel through which the inbound message arrived. */
  sourceChannel: ChannelId;
  /** Trust classification -- see {@link TrustClass} for semantics. */
  trustClass: "guardian" | "trusted_contact" | "unknown";
  /** Chat/conversation ID for delivering guardian notifications. */
  guardianChatId?: string;
  /** Canonical external user ID of the guardian for this (assistant, channel) binding. */
  guardianExternalUserId?: string;
  /** Internal principal ID of the guardian. */
  guardianPrincipalId?: string;
  /** Human-readable identifier for the requester (e.g. @username or phone number). */
  requesterIdentifier?: string;
  /** Preferred display name for the requester (member name or sender name). */
  requesterDisplayName?: string;
  /** Raw sender display name as provided by the channel transport. */
  requesterSenderDisplayName?: string;
  /** Guardian-managed display name from the contact record. */
  requesterMemberDisplayName?: string;
  /** Canonical external user ID of the requester (the current actor). */
  requesterExternalUserId?: string;
  /** Chat/conversation ID the requester is interacting through. */
  requesterChatId?: string;
}

/**
 * Trust context used by internal background jobs (memory consolidation,
 * update bulletin, scheduled tasks) when invoking the agent loop without
 * an inbound actor identity. The assistant is the guardian over its own
 * internal state, so self-maintenance flows clear the side-effect
 * approval gate. Inbound message conversations resolve trust per-actor
 * via `resolveTrustContext()` and must not use this constant.
 */
export const INTERNAL_GUARDIAN_TRUST_CONTEXT = {
  sourceChannel: "vellum",
  trustClass: "guardian",
} as const satisfies TrustContext;
