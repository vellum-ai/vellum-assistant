/**
 * Reading the acting turn's identity, and reporting when it is missing.
 *
 * Consumers call {@link resolveTurnIdentity} instead of reaching for
 * `currentTurn*` fields or the conversation's live values. While the
 * migration is in progress the conversation-level values remain as a
 * fallback, because at least one legitimate flow depends on them: a deferred
 * wake fires with no inbound actor, and removing the fallback before every
 * entry point supplies an identity reproduces LUM-2929, where every sensitive
 * tool in a resumed turn was denied.
 *
 * The fallback is therefore kept, but it is no longer silent. Each use logs
 * which consumer reached it and how it resolved. That signal is the evidence
 * the fallback can eventually be deleted: seven previous fixes each asserted
 * that one more consumer now read the right value, and none of them could
 * show whether any consumer still did not.
 */

import { getLogger } from "../util/logger.js";
import type { TrustContext } from "./trust-context-types.js";
import type { TurnIdentity } from "./turn-identity.js";

const log = getLogger("turn-identity");

/** The conversation fields this resolver may fall back to. */
export interface TurnIdentityFallbackSource {
  currentTurn?: TurnIdentity;
  /** Legacy per-turn snapshot, retained until every entry point sets `currentTurn`. */
  currentTurnTrustContext?: TrustContext;
  /** The conversation's resting trust: whichever actor sent most recently. */
  trustContext?: TrustContext;
  readonly conversationId: string;
}

/** Where a resolved trust value came from, for the migration signal. */
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
 * Resolve the trust the acting turn runs under.
 *
 * `consumer` names the call site in the emitted signal, so a non-`turn`
 * resolution points at the code that needs an identity it is not being given
 * rather than just reporting that one occurred.
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

  // Deliberately `warn`: this is the migration's completion signal, and a
  // level that gets filtered out would make "the fallback is unused" look
  // true before it is.
  log.warn(
    {
      event: "turn_identity_fallback",
      consumer,
      conversationId: ctx.conversationId,
      source,
      trustClass: (legacy ?? resting)?.trustClass,
      sourceChannel: (legacy ?? resting)?.sourceChannel,
    },
    "Turn identity absent; resolved trust from a fallback",
  );

  return { trust: legacy ?? resting, source };
}
