/**
 * Conversation admission: run a send when the conversation is free to take it.
 *
 * One deferral primitive for every send that cannot interrupt the turn in
 * flight. A send registered here waits for the conversation's processing lock
 * to free and for the finished turn's boundary commit to settle, then runs.
 * Registrations for the same conversation run one at a time in arrival order,
 * so a conversation's deferred sends keep the order they were sent in.
 *
 * Why a wait rather than an error: a machine-injected send (a subagent or ACP
 * completion, a plugin-driven turn, a channel inbound turn) has no user to
 * retry it. `processMessage` and `persistUserMessage` reject with
 * `CONVERSATION_BUSY_MESSAGE` while a turn holds the lock, and a caller that
 * treats that as failure drops the message: channel ingress dead-lettered a
 * Slack thread reply on the first try for exactly this reason (JARVIS-1346).
 *
 * What it guarantees:
 *
 * - **FIFO per conversation.** The single-flight slot is held for the whole of
 *   `run`, so the next registration is not admitted until this one is done with
 *   the conversation. Different conversations never wait on each other.
 * - **Idle, then the turn boundary.** The finished turn releases the processing
 *   flag before its turn-boundary commit runs, and that commit attributes the
 *   working tree to the turn that just ended. A send admitted in that window
 *   would have its first file writes swept into the previous turn's commit, so
 *   admission waits out the finalization barrier too, without a deadline.
 * - **An evicted conversation admits.** Idle release is event-driven, and a
 *   conversation disposed while a send waited would never fire its waiters. The
 *   wait re-reads the registry in slices, so a send addressed to a conversation
 *   that is no longer resident admits and lets `run` hydrate it.
 * - **A lost lock race is retried.** A non-admission claimant (a voice turn, a
 *   wake) can take the lock on the same transition that released this send. Up
 *   to {@link MAX_BUSY_ATTEMPTS} attempts re-chain behind it; past that the
 *   sender is told the send failed.
 * - **Bounded.** {@link MAX_PENDING_ADMISSIONS} registrations per conversation;
 *   beyond that registration rejects with {@link AdmissionOverflowError} and
 *   `run` is never called.
 */

import type { AssistantEvent } from "../api/index.js";
import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { createKeyedSingleFlight } from "../util/single-flight.js";
import { resolveTurnCommitWaitMs } from "./abort-watchdog.js";
import { isConversationBusyError } from "./conversation-messaging.js";
import { findConversationOrSubagent } from "./conversation-registry.js";
import {
  hasOpenTurnFinalization,
  startAfterTurnFinalization,
} from "./turn-finalization.js";

const log = getLogger("conversation-admission");

/**
 * Longest a single `waitForIdle` slice blocks before the admission loop
 * re-reads the conversation's state. Idle release is event-driven (the wait
 * resolves the instant the lock frees), so this slice only bounds how quickly
 * we notice a conversation that was evicted or disposed while we waited: its
 * idle waiters would never fire, so the loop re-reads `findConversation` and
 * admits.
 */
const IDLE_WAIT_SLICE_MS = 30_000;

/**
 * Attempts a registration gets when `run` rejects with the processing-lock
 * error. Three covers a claimant that took the lock on the release transition;
 * a conversation that keeps losing the race that many times is contended by
 * something that is not going to yield to a retry either.
 */
export const MAX_BUSY_ATTEMPTS = 3;

/**
 * Registrations a single conversation may hold. User sends interrupt rather
 * than wait, so in practice the count stays in the low single digits; this is
 * the ceiling that keeps a misbehaving injector from growing the chain without
 * bound.
 */
export const MAX_PENDING_ADMISSIONS = 64;

/** Rejection from {@link runWhenConversationIdle} when the chain is full. */
export class AdmissionOverflowError extends Error {
  readonly conversationId: string;
  readonly pending: number;

  constructor(conversationId: string, pending: number) {
    super(
      `Conversation ${conversationId} already has ${pending} sends waiting to run`,
    );
    this.name = "AdmissionOverflowError";
    this.conversationId = conversationId;
    this.pending = pending;
  }
}

export interface AdmissionOptions {
  /** Who registered the send, for logs. */
  origin: string;
  /** The sender's event sink, told when the send could not be delivered. */
  onEvent?: (msg: AssistantEvent) => void;
  /** Correlation id carried on the failure event. */
  requestId?: string;
}

const runAdmissionSingleFlight = createKeyedSingleFlight();

/** Registrations waiting or running, per conversation. */
const pendingByConversation = new Map<string, number>();

/**
 * How many sends are registered for this conversation and have not finished.
 *
 * Counts the one currently running as well as those still waiting, so a reader
 * asking "is there work here that would be lost" gets `true` for the whole
 * window between registration and completion.
 */
export function pendingAdmissionCount(conversationId: string): number {
  return pendingByConversation.get(conversationId) ?? 0;
}

/**
 * False when this conversation's chain is full, so {@link
 * runWhenConversationIdle} would reject with {@link AdmissionOverflowError}.
 *
 * For a caller that answers its own request before the deferred send runs and
 * has to refuse the send in that answer rather than in a rejection nobody is
 * awaiting. Read it immediately before registering: nothing else may take the
 * last slot in between, because registration is synchronous.
 */
export function canDeferSend(conversationId: string): boolean {
  return pendingAdmissionCount(conversationId) < MAX_PENDING_ADMISSIONS;
}

function retainAdmission(conversationId: string): void {
  pendingByConversation.set(
    conversationId,
    pendingAdmissionCount(conversationId) + 1,
  );
}

function releaseAdmission(conversationId: string): void {
  const next = pendingAdmissionCount(conversationId) - 1;
  if (next <= 0) {
    pendingByConversation.delete(conversationId);
    return;
  }
  pendingByConversation.set(conversationId, next);
}

/**
 * Run `run` once the conversation is free to accept it.
 *
 * Resolves with `run`'s result, or rejects with whatever `run` rejected with
 * once the busy retries are spent. Rejects with {@link AdmissionOverflowError}
 * before registering anything when the conversation's chain is full: callers
 * that answer a request synchronously check for it to refuse the send, and
 * callers that registered fire-and-forget log it.
 *
 * `run` takes the conversation's processing lock itself. The slot is held until
 * `run` settles, so a `run` that awaits its whole turn keeps the next
 * registration out until the turn ends, and a `run` that only starts a turn
 * hands the next registration straight on to that turn's own lock.
 */
export async function runWhenConversationIdle<T>(
  conversationId: string,
  run: () => Promise<T>,
  options: AdmissionOptions,
): Promise<T> {
  const pending = pendingAdmissionCount(conversationId);
  if (pending >= MAX_PENDING_ADMISSIONS) {
    throw new AdmissionOverflowError(conversationId, pending);
  }
  retainAdmission(conversationId);
  try {
    return await runAdmissionSingleFlight(conversationId, () =>
      admit(conversationId, run, options),
    );
  } finally {
    releaseAdmission(conversationId);
  }
}

async function admit<T>(
  conversationId: string,
  run: () => Promise<T>,
  options: AdmissionOptions,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await waitUntilAdmissible(conversationId, options.origin);
    try {
      return await run();
    } catch (err) {
      if (!isConversationBusyError(err)) {
        throw err;
      }
      if (attempt >= MAX_BUSY_ATTEMPTS) {
        log.error(
          { conversationId, origin: options.origin, attempts: attempt },
          "Deferred send lost the processing lock on every attempt",
        );
        options.onEvent?.({
          type: "error",
          conversationId,
          ...(options.requestId ? { requestId: options.requestId } : {}),
          code: "SEND_FAILED",
          message: "Your message could not be delivered. Please send it again.",
          errorCategory: "internal",
        });
        throw err;
      }
      log.info(
        { conversationId, origin: options.origin, attempt },
        "Deferred send lost the processing lock to another claimant; waiting for idle again",
      );
    }
  }
}

/**
 * Block until the conversation holds no processing lock and no turn-boundary
 * commit is still staging the working tree.
 *
 * A claimant that takes the lock while the barrier is being awaited sends the
 * loop back to the idle wait, so the two conditions are true together when this
 * returns rather than one after the other.
 */
async function waitUntilAdmissible(
  conversationId: string,
  origin: string,
): Promise<void> {
  let deferred = false;
  for (;;) {
    const conversation = findConversationOrSubagent(conversationId);
    // Subagent conversations are held in their own map, so the lookup is the
    // union: a send addressed to a child has to see the child's lock, not miss
    // it and run straight into a busy rejection.
    //
    // A non-resident conversation is not mid-turn: `run` will hydrate and lock
    // it. Its own lock check is the authoritative guard, so a turn that races
    // in after this point surfaces as a busy error the retry above handles.
    if (!conversation || !conversation.isProcessing()) {
      await waitForCommitBarrier(conversationId);
      const settled = findConversationOrSubagent(conversationId);
      if (!settled || !settled.isProcessing()) {
        if (deferred) {
          log.info(
            { conversationId, origin },
            "Deferred send admitted after waiting for the in-flight turn to finish",
          );
        }
        return;
      }
      continue;
    }
    if (!deferred) {
      deferred = true;
      log.info(
        { conversationId, origin },
        "Send deferred: conversation is mid-turn, waiting for it to finish",
      );
    }
    await conversation.waitForIdle({ timeoutMs: IDLE_WAIT_SLICE_MS });
  }
}

/**
 * Wait out the finished turn's boundary barrier.
 *
 * The wait has no deadline, which is {@link startAfterTurnFinalization}'s own
 * reasoning: admitting on a budget that elapsed is the exact cross-attribution
 * the barrier exists to prevent, and giving up loses the message. The budget
 * only decides when to say out loud that the barrier is taking unusually long.
 */
async function waitForCommitBarrier(conversationId: string): Promise<void> {
  if (!hasOpenTurnFinalization(conversationId)) {
    return;
  }
  const ceilingMs = resolveTurnCommitWaitMs(
    getConfig().workspaceGit?.turnCommitMaxWaitMs,
  );
  await new Promise<void>((resolve) => {
    startAfterTurnFinalization(conversationId, ceilingMs, resolve);
  });
}

/**
 * Clear the per-conversation chains and pending counts. Test-only; production
 * entries self-clear once nothing is waiting behind them.
 *
 * @internal
 */
export function __resetConversationAdmissionForTests(): void {
  runAdmissionSingleFlight.reset();
  pendingByConversation.clear();
}
