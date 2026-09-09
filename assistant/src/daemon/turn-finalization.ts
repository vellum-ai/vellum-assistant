/**
 * A per-conversation barrier for the work a turn does after it frees the
 * conversation.
 *
 * A turn releases the processing flag as soon as its content is settled, which
 * is what lets the next direct send start without waiting. The turn-boundary
 * commit runs after that release, and it attributes whatever the working tree
 * holds to the turn that just ended: a turn that started writing files in the
 * meantime has its first writes swept into the finished turn's commit.
 *
 * The queue drain avoids this by running after the commit inside the loop's own
 * `finally`. A caller that starts a turn from outside the loop (the interrupt
 * path, which hands a conversation straight from the turn it stopped to the
 * message that stopped it) has no such ordering, so it waits here instead.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("turn-finalization");

const pendingFinalizations = new Map<
  string,
  { promise: Promise<void>; settle: () => void }
>();

/**
 * Open the barrier for a turn that is starting. Returns the closer, which the
 * turn calls once everything the next turn must not overlap with is done.
 *
 * Idempotent per turn, and safe to leave uncalled on a crash path only to the
 * extent that {@link waitForTurnFinalization} is deadline-bounded. A turn that
 * opens a barrier while another is somehow still open settles the old one
 * first, so nothing waits on a barrier no turn will close.
 */
export function beginTurnFinalization(conversationId: string): () => void {
  pendingFinalizations.get(conversationId)?.settle();
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const entry = { promise, settle };
  pendingFinalizations.set(conversationId, entry);
  return () => {
    if (pendingFinalizations.get(conversationId) === entry) {
      pendingFinalizations.delete(conversationId);
    }
    settle();
  };
}

/**
 * Wait for the conversation's open barrier to close.
 *
 * Resolves `true` when there is nothing to wait for or the barrier closed
 * inside the budget, `false` when the budget elapsed first. A caller that gets
 * `false` must not start a turn: the finished turn is still preparing a commit
 * that would capture the new turn's writes.
 */
export async function waitForTurnFinalization(
  conversationId: string,
  timeoutMs: number,
): Promise<boolean> {
  const entry = pendingFinalizations.get(conversationId);
  if (!entry) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([entry.promise.then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: drop every open barrier. */
export function resetTurnFinalizationsForTesting(): void {
  for (const entry of pendingFinalizations.values()) {
    entry.settle();
  }
  pendingFinalizations.clear();
}

/**
 * Run `start` once the conversation's finalization barrier has closed, or at
 * once when none is open.
 *
 * For callers that must not begin a turn while a finished turn is still
 * staging the working tree, but that also must not hold anything up waiting:
 * the interrupt's queue fallback kicks the drain from a request that has
 * already been answered, and a drain that started immediately would let the
 * previous turn's commit capture the replacement turn's first file writes.
 *
 * Unlike {@link waitForTurnFinalization} this has no deadline, and that is the
 * point. A deadline here would have to choose between two bad answers when it
 * elapsed: start anyway, which is the exact cross-attribution this exists to
 * prevent, or give up, which loses the message. It waits for the barrier
 * instead, which the turn always closes: the turn-boundary commit is itself
 * bounded, and the barrier closes on that commit settling either way.
 * `ceilingMs` only decides when to say out loud that it is taking unusually
 * long.
 */
export function startAfterTurnFinalization(
  conversationId: string,
  ceilingMs: number,
  start: () => void,
): void {
  const entry = pendingFinalizations.get(conversationId);
  if (!entry) {
    start();
    return;
  }
  let settled = false;
  const warnTimer = setTimeout(() => {
    if (settled) {
      return;
    }
    log.warn(
      { conversationId, ceilingMs },
      "Turn finalization is outlasting the commit budget; still holding the drain rather than starting a turn over a live commit",
    );
  }, ceilingMs);
  // Never keeps the process alive on its own: this only reports.
  warnTimer.unref?.();
  const run = (): void => {
    settled = true;
    clearTimeout(warnTimer);
    start();
  };
  void entry.promise.then(run, run);
}
