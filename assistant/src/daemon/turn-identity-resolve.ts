/**
 * Reading the acting turn's identity.
 *
 * Consumers call {@link resolveTurnTrust} rather than reaching for the
 * conversation's per-turn or resting trust fields directly.
 *
 * A turn started by a path that cannot name its actor has no identity, and the
 * conversation-level values answer instead. Some flows rely on that: a
 * deferred wake fires with no inbound actor, and denying it an answer here
 * fails its whole turn closed. The fallback is therefore live behaviour, not
 * dead code.
 *
 * Each fallback is reported once per turn so the set of consumers still
 * reaching it is observable rather than assumed.
 */

import { getLogger } from "../util/logger.js";
import type { TrustContext } from "./trust-context-types.js";
import type { TurnIdentity } from "./turn-identity.js";

const log = getLogger("turn-identity");

/** The conversation fields this resolver may fall back to. */
export interface TurnIdentityFallbackSource {
  currentTurn?: TurnIdentity;
  currentTurnTrustContext?: TrustContext;
  /** The conversation's resting trust: whichever actor sent most recently. */
  trustContext?: TrustContext;
  readonly conversationId: string;
  /** Identifies the turn, so a fallback is reported once rather than per tool call. */
  currentRequestId?: string;
}

/** Where a resolved trust value came from. */
export type TurnTrustSource =
  | "turn"
  | "legacy_turn_snapshot"
  | "conversation"
  | "none";

export interface ResolvedTurnTrust {
  trust: TrustContext | undefined;
  source: TurnTrustSource;
}

/**
 * Consumers that have already reported a fallback for a given turn, keyed by
 * `conversationId:requestId:consumer`. A turn issues many tool calls and would
 * otherwise emit one line each.
 *
 * Bounded so a long-lived daemon cannot accumulate keys without limit; the set
 * is a reporting aid, and dropping the oldest entries only risks a duplicate
 * line.
 */
const reportedFallbacks = new Set<string>();
const REPORTED_FALLBACKS_MAX = 1_000;

/**
 * Resolve the trust the acting turn runs under.
 *
 * `consumer` names the call site in the report, so a fallback points at the
 * code that needs an identity it is not being given.
 */
export function resolveTurnTrust(
  ctx: TurnIdentityFallbackSource,
  consumer: string,
): ResolvedTurnTrust {
  if (ctx.currentTurn) {
    return { trust: ctx.currentTurn.trust, source: "turn" };
  }

  const legacy = ctx.currentTurnTrustContext;
  const resting = ctx.trustContext;
  const source: TurnTrustSource = legacy
    ? "legacy_turn_snapshot"
    : resting
      ? "conversation"
      : "none";

  const key = `${ctx.conversationId}:${ctx.currentRequestId ?? "-"}:${consumer}`;
  if (!reportedFallbacks.has(key)) {
    if (reportedFallbacks.size >= REPORTED_FALLBACKS_MAX) {
      reportedFallbacks.clear();
    }
    reportedFallbacks.add(key);
    // Identifiers only. The actor's trust class and channel are the kind of
    // metadata that should not be written to a rotating log on a path that
    // fires for ordinary background work.
    log.warn(
      {
        event: "turn_identity_fallback",
        consumer,
        conversationId: ctx.conversationId,
        requestId: ctx.currentRequestId,
        source,
      },
      "Turn identity absent; resolved trust from a fallback",
    );
  }

  return { trust: legacy ?? resting, source };
}

/** Test seam: drop the once-per-turn reporting memory. */
export function resetTurnIdentityFallbackReporting(): void {
  reportedFallbacks.clear();
}
