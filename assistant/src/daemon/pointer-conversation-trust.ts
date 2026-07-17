/**
 * Guardian-trust elevation for call-status pointer turns.
 *
 * Call-status pointer messages are generated as owner self-maintenance turns:
 * only the owner's own conversations route through the daemon processor (see
 * `resolvePointerAudienceIsOwner` in `calls/call-pointer-messages.ts`; contact
 * and unknown audiences take the deterministic fallback instead), so the
 * generation runs under the internal guardian context.
 *
 * The subtlety is history: `Conversation.loadFromDb` filters the persisted
 * history to non-guardian provenance whenever the active trust context cannot
 * access memory. On a cold (evicted) load — common on a memory-pressured daemon
 * that evicts idle conversations — a freshly rebuilt conversation has no trust
 * context, so a guardian-authored conversation's entire history is filtered to
 * empty. The pointer turn would then ship with only its freshly persisted
 * instruction, and because dropping the prior history (and tools) shifts the
 * cacheable prefix, the request misses the prompt cache completely.
 *
 * Elevating to the guardian context and rehydrating before the turn restores
 * the full history and makes the turn's shape deterministic regardless of
 * eviction state.
 */
import { resolveCapabilities } from "../runtime/capabilities.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "./trust-context.js";
import type { TrustContext } from "./trust-context-types.js";

/** Minimal `Conversation` surface needed to elevate pointer trust. */
export interface GuardianElevatableConversation {
  readonly trustContext?: TrustContext | undefined;
  isProcessing(): boolean;
  setTrustContext(ctx: TrustContext | null): void;
  ensureActorScopedHistory(): Promise<void>;
}

/**
 * Elevate a pointer conversation to the internal guardian context and rehydrate
 * its history so guardian-authored history is not filtered to empty on a cold
 * load. Returns a function that restores the prior trust context.
 *
 * Elevation is restricted to the owner's own conversation: an explicit guardian
 * context, or a trust-less cold load (an evicted owner conversation whose actor
 * trust has not been re-resolved). It no-ops (returning a no-op restorer) when
 * the prior context belongs to a known contact (`trusted_contact` /
 * `unverified_contact`) or any other non-owner actor — rehydrating guardian-only
 * history into a contact's conversation would leak it. It also no-ops when the
 * conversation is already memory-capable, or when it is mid-turn — mutating
 * `trustContext` during an active loop would elevate that turn's actor trust
 * (mirrors the warm-path guard in `conversation-store.ts`).
 */
export async function elevatePointerConversationToGuardian(
  conversation: GuardianElevatableConversation,
): Promise<() => void> {
  const priorTrustContext = conversation.trustContext;
  const priorTrustClass = priorTrustContext?.trustClass;
  // Only the owner may be elevated: an explicit guardian context (already
  // memory-capable, so the capability check below no-ops it) or a trust-less
  // cold load. Contact and unknown actors are excluded so guardian-only history
  // is never rehydrated into a non-owner conversation.
  const isOwnerContext =
    priorTrustClass === undefined || priorTrustClass === "guardian";
  const shouldElevate =
    isOwnerContext &&
    !resolveCapabilities(priorTrustClass).canAccessMemory &&
    !conversation.isProcessing();
  if (!shouldElevate) return () => {};

  conversation.setTrustContext(INTERNAL_GUARDIAN_TRUST_CONTEXT);
  await conversation.ensureActorScopedHistory();

  return () => {
    // Undo only the elevation this call installed. If a new turn started at an
    // await boundary and legitimately updated trustContext, the reference will
    // differ and we leave it alone.
    if (conversation.trustContext === INTERNAL_GUARDIAN_TRUST_CONTEXT) {
      conversation.setTrustContext(priorTrustContext ?? null);
    }
  };
}
