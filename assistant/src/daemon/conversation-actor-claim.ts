/**
 * The processing claim a turn takes before it stamps its sender and scopes the
 * resident history for them.
 */

import type { QueueDrainReason } from "./conversation-queue-manager.js";
import type { TrustContext } from "./trust-context-types.js";

/**
 * A claim still preparing its turn: taken, but with no agent loop and no abort
 * controller behind it yet. It covers everything a sender does before its turn
 * starts (the history reload, slash resolution, a canned reply's writes), and
 * ends in exactly two places: the persist that installs the turn's abort
 * controller ({@link endPreparingClaim}), and the release of the claim
 * ({@link releasePreparingClaim}). `cancelled` is set by a Stop or steer that
 * lands in that window; the holder checks it with {@link isClaimLive} before
 * each write and gives the claim back instead of writing.
 */
export interface PreparingClaim {
  readonly owner: number;
  cancelled: boolean;
  /**
   * The trust this claim stamped on the conversation and the trust it
   * replaced, when it stamped one. A release that finds the claim still
   * preparing and nothing committed puts the replaced trust back, so a sender
   * whose message never landed is not left as the conversation's resting
   * actor.
   */
  stamp?: {
    readonly stamped: TrustContext | undefined;
    readonly prior: TrustContext | undefined;
  };
  /** Set once a row this claim's sender wrote has landed. */
  committed: boolean;
}

/** The conversation surface {@link acquireProcessingForActor} needs. */
export interface ActorClaimContext {
  trustContext?: TrustContext;
  preparingClaim: PreparingClaim | null;
  acquireProcessingFenced(): Promise<number | null>;
  holdsProcessingClaim(owner: number): boolean;
  releaseProcessing(owner: number): boolean;
  kickDrainQueue(reason?: QueueDrainReason, origin?: string): Promise<void>;
  setTrustContext(ctx: TrustContext | null): void;
  ensureActorScopedHistory(): Promise<void>;
}

/**
 * Take the processing claim for a turn, then stamp the sender's trust and
 * scope the resident history for it, all under that claim.
 *
 * Scoping awaits a history reload. Two senders can reach an idle conversation
 * together, and if they scoped before claiming, the second could overwrite the
 * trust slot or replace `messages` during the first one's reload, so the first
 * turn would start on the other actor's history. Under the claim, the second
 * finds the conversation busy before it touches either.
 *
 * The claim is published as preparing, so a Stop before the turn starts
 * cancels it rather than force-clearing a flag it would otherwise read as
 * latched. Clearing it there would let another sender acquire and reload while
 * this sender is still reloading or writing.
 *
 * An undefined `trustContext` keeps the conversation's current trust. Null is
 * a conversation this sender cannot have: busy when asked, or cancelled or
 * claimed away during the reload. In the last two cases the claim is given
 * back, and its release puts back the trust this call stamped. A reload that
 * throws does the same before the error propagates.
 */
export async function acquireProcessingForActor(
  ctx: ActorClaimContext,
  trustContext: TrustContext | null | undefined,
): Promise<number | null> {
  const owner = await ctx.acquireProcessingFenced();
  if (owner === null) {
    return null;
  }
  const preparation: PreparingClaim = {
    owner,
    cancelled: false,
    committed: false,
    ...(trustContext !== undefined
      ? {
          stamp: {
            stamped: trustContext ?? undefined,
            prior: ctx.trustContext,
          },
        }
      : {}),
  };
  ctx.preparingClaim = preparation;
  const giveBack = (origin: string): void => {
    if (ctx.releaseProcessing(owner)) {
      void ctx.kickDrainQueue("loop_complete", origin);
    } else {
      // Claimed away: the slot is no longer this sender's to put back.
      endPreparingClaim(ctx, owner);
    }
  };
  try {
    if (trustContext !== undefined) {
      ctx.setTrustContext(trustContext);
    }
    await ctx.ensureActorScopedHistory();
  } catch (err) {
    giveBack("actor_scope_failed");
    throw err;
  }
  if (!isClaimLive(ctx, owner)) {
    giveBack("actor_scope_cancelled");
    return null;
  }
  return owner;
}

/**
 * Cancel the live claim if it is still preparing its turn. Reports whether it
 * did, which tells an abort that the claim's holder will release it.
 */
export function cancelPreparingClaim(
  ctx: Pick<ActorClaimContext, "preparingClaim" | "holdsProcessingClaim">,
): boolean {
  const preparation = ctx.preparingClaim;
  if (!preparation || !ctx.holdsProcessingClaim(preparation.owner)) {
    return false;
  }
  preparation.cancelled = true;
  return true;
}

/**
 * Whether a claim taken by {@link acquireProcessingForActor} may still write:
 * it is the live hold, and no Stop has cancelled it. Asked immediately before
 * each write a sender makes ahead of its turn.
 */
export function isClaimLive(
  ctx: Pick<ActorClaimContext, "holdsProcessingClaim"> & {
    preparingClaim?: PreparingClaim | null;
  },
  owner: number,
): boolean {
  const preparation = ctx.preparingClaim;
  return (
    ctx.holdsProcessingClaim(owner) &&
    !(preparation?.owner === owner && preparation.cancelled)
  );
}

/**
 * End the preparing window of `owner`'s claim, if it is still open, because
 * its turn has started.
 */
export function endPreparingClaim(
  ctx: { preparingClaim?: PreparingClaim | null },
  owner: number,
): void {
  if (ctx.preparingClaim?.owner === owner) {
    ctx.preparingClaim = null;
  }
}

/** Record that a row `owner`'s sender wrote has landed. */
export function commitPreparingClaim(
  ctx: { preparingClaim?: PreparingClaim | null },
  owner: number,
): void {
  if (ctx.preparingClaim?.owner === owner) {
    ctx.preparingClaim.committed = true;
  }
}

/**
 * End the preparing window of `owner`'s claim as the claim is released.
 *
 * A claim released while still preparing started no turn. When nothing it
 * wrote landed either, the trust it stamped is put back, but only while the
 * slot still holds that stamp: a writer that moved the slot since keeps it.
 */
export function releasePreparingClaim(
  ctx: {
    preparingClaim?: PreparingClaim | null;
    trustContext?: TrustContext;
    setTrustContext(ctx: TrustContext | null): void;
  },
  owner: number,
): void {
  const preparation = ctx.preparingClaim;
  if (preparation?.owner !== owner) {
    return;
  }
  ctx.preparingClaim = null;
  const { stamp } = preparation;
  if (!preparation.committed && stamp && ctx.trustContext === stamp.stamped) {
    ctx.setTrustContext(stamp.prior ?? null);
  }
}
