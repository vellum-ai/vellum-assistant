/**
 * Observed health of the conversation-title call site.
 *
 * The title pipeline is fire-and-forget: the `user-prompt-submit` hook defers
 * the call to a later macrotask so it never claims a provider slot ahead of
 * the user-visible response, and the queue wrapper `void`s the promise. So a
 * title failure can never be observed during the turn that caused it. By the
 * time the model refuses, that turn's prompt is long gone.
 *
 * A latch bridges that gap. A refusal the title service has already classified
 * as permanent (`model_unavailable`, meaning the resolved model is one the
 * connection will not serve) is recorded here, and the next turn that would
 * spend a title call reads it back synchronously. Observation rather than
 * prediction: no probe on the prompt-submit path, and no false positives,
 * because the fault being reported is one that actually happened. The cost is
 * a one-turn lag, so the first failure is silent.
 *
 * Deliberately in-memory. The fault is a property of the running daemon's
 * resolved configuration, so a restart re-derives it on the next title call
 * rather than reporting a fault that a config change may already have fixed.
 * Any successful generation clears it, which is what makes it self-healing.
 */

export interface TitleModelFault {
  /** Model the `conversationTitle` call site resolved to, when known. */
  readonly model?: string;
  /** Provider the call site resolved to, when known. */
  readonly provider?: string;
  /** `provider_connections` row whose credential refused the call. */
  readonly connectionName?: string;
}

let fault: TitleModelFault | null = null;

/**
 * Conversations already told about the current fault. Titling stays broken
 * for as long as the configuration does, and a failed title leaves the
 * conversation replaceable, so the "would we generate a title" gate stays true
 * on every subsequent turn. Without this the notice would ride along with
 * every message the user sends. One notice per conversation per fault episode
 * is enough to explain what they are seeing.
 */
let notifiedConversations = new Set<string>();

/**
 * Record that the title call site resolved to a model its connection refuses.
 * Idempotent: re-recording the same fault does not re-arm conversations that
 * were already told.
 */
export function recordTitleModelFault(next: TitleModelFault): void {
  if (
    fault &&
    fault.model === next.model &&
    fault.provider === next.provider &&
    fault.connectionName === next.connectionName
  ) {
    return;
  }
  fault = next;
  // A different fault is a different explanation, so every conversation is
  // eligible to hear the new one.
  notifiedConversations = new Set();
}

/**
 * Clear the latch. Called when a title generates successfully: whatever the
 * configuration was, it works now, so nothing should still be reporting that
 * it doesn't.
 */
export function clearTitleModelFault(): void {
  fault = null;
  notifiedConversations = new Set();
}

/** The current fault, or `null` when titling is healthy or untested. */
export function getTitleModelFault(): TitleModelFault | null {
  return fault;
}

/**
 * Claim the one notice this conversation gets for the current fault: returns
 * the fault the first time it is called for a conversation and `null` on every
 * later call. Claiming and reading are one operation so two turns racing on
 * the same conversation cannot both emit it.
 */
export function claimTitleModelFaultNotice(
  conversationId: string,
): TitleModelFault | null {
  if (!fault || notifiedConversations.has(conversationId)) {
    return null;
  }
  notifiedConversations.add(conversationId);
  return fault;
}

/** Test seam: drops both the fault and the per-conversation notice ledger. */
export function resetTitleModelFaultForTests(): void {
  clearTitleModelFault();
}
