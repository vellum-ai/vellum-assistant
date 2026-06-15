/**
 * Trust context resolved during inbound message processing.
 *
 * Extracted from conversation-runtime-assembly.ts to break circular
 * imports (memory/conversation-crud → daemon/conversation-runtime-assembly).
 */
import type { ChannelId } from "../channels/types.js";
import { isHttpAuthDisabled } from "../config/env.js";
import { shouldExposePersonalMemory } from "../memory/v2/static-context.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";

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
  /** Raw timezone for the requester, when supplied by the source channel. */
  requesterTimezone?: string;
  /** Compact timezone label for the requester, when supplied by the source channel. */
  requesterTimezoneLabel?: string;
  /** Raw timezone offset in seconds for the requester, when supplied by the source channel. */
  requesterTimezoneOffsetSeconds?: number;
  /** Canonical external user ID of the requester (the current actor). */
  requesterExternalUserId?: string;
  /** Chat/conversation ID the requester is interacting through. */
  requesterChatId?: string;
}

/**
 * Trust context used by internal background jobs (memory consolidation,
 * scheduled tasks) when invoking the agent loop without
 * an inbound actor identity. The assistant is the guardian over its own
 * internal state, so self-maintenance flows clear the side-effect
 * approval gate. Inbound message conversations resolve trust per-actor
 * via `resolveTrustContext()` and must not use this constant.
 */
export const INTERNAL_GUARDIAN_TRUST_CONTEXT = {
  sourceChannel: "vellum",
  trustClass: "guardian",
} as const satisfies TrustContext;

/**
 * Synthetic fallback trust context used when a pipeline fires before the
 * per-turn trust snapshot has been captured (e.g. fresh conversations before
 * the trust resolver runs, heartbeat turns that never bind an actor, or
 * non-turn invocations like `Conversation.forceCompact`). We bias to
 * `unknown` rather than `guardian` so a missing snapshot cannot accidentally
 * grant elevated trust to a custom plugin reading `ctx.trust`.
 */
export const FALLBACK_TURN_TRUST: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "unknown",
};

/**
 * Resolve the effective trust class for an actor.
 *
 * When HTTP auth is disabled (dev bypass), always returns `'guardian'`
 * so that control-plane gates don't block local development.
 *
 * When no trust context is available (e.g. desktop-only conversations that
 * don't go through channel trust resolution), defaults to `'unknown'`
 * to fail-closed.
 */
export function resolveTrustClass(
  trustContext: TrustContext | undefined,
): TrustClass {
  if (isHttpAuthDisabled()) return "guardian";
  return trustContext?.trustClass ?? "unknown";
}

/**
 * Whether personal-memory content may be surfaced for the actor described by
 * `trustContext`: the gate admits guardian-class actors and internal/local
 * flows (including turns with no trust context), and blocks remote untrusted
 * actors — see {@link shouldExposePersonalMemory} for the rationale.
 *
 * This is THE personal-memory trust gate. Every surface that exposes private
 * user content — the v2 dynamic/static `<memory>` layers, PKB context, NOW.md,
 * memory-v3 cards/spotlight, and the `loadFromDb` rehydration of persisted
 * memory blocks — must call this one helper so the exposure rule cannot drift
 * between copies. It folds in {@link resolveTrustClass} so the dev-bypass
 * (HTTP auth disabled → guardian) applies uniformly at every call site.
 */
export function isPersonalMemoryAllowed(
  trustContext: TrustContext | undefined,
): boolean {
  return shouldExposePersonalMemory({
    sourceChannel: trustContext?.sourceChannel,
    isTrustedActor: resolveTrustClass(trustContext) === "guardian",
  });
}
