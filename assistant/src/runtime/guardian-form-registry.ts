/**
 * The parking rail behind every guardian form.
 *
 * A form-backed command does not write. It parks here, its form goes to every
 * connected client, and the write happens elsewhere (today the gateway, which
 * owns contact writes) and reports back. With no human at a form, nothing is
 * written and the call times out. That property is what makes these commands
 * guardian-gated, and it lives in this file rather than in any one form.
 *
 * What a form owner supplies: how to broadcast it, how to take it down, and
 * what its result looks like. Everything below is the same for all of them.
 *
 * Lifecycle:
 *   open   -> the call parks, the form goes out, a deadline starts
 *   claim  -> one submission wins; the answer deadline is swapped for a
 *             bounded settle window while the write runs
 *   resolve-> the write reports back, the parked call returns, the card is
 *             retired everywhere it is showing
 *
 * See `docs/guardian-forms.md` for how to add one.
 */

import { v4 as uuid } from "uuid";

import {
  GUARDIAN_FORM_DEFAULT_TIMEOUT_MS,
  GUARDIAN_FORM_SETTLE_MS,
} from "../util/guardian-form-timeouts.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("guardian-form-registry");

/** Every form's result carries at least this; owners widen it. */
export interface GuardianFormResult {
  ok: boolean;
  error?: string;
}

export type GuardianFormClosedReason = "answered" | "cancelled" | "timed_out";

/**
 * How a form reaches clients and how it leaves them.
 *
 * Both are the owner's, because the event names are wire contract. The
 * registry decides *when* they fire.
 */
export interface GuardianFormBroadcast {
  open: (requestId: string) => void;
  closed: (requestId: string, reason: GuardianFormClosedReason) => void;
}

interface PendingGuardianForm {
  kind: string;
  resolve: (result: GuardianFormResult) => void;
  timer: ReturnType<typeof setTimeout>;
  closed: GuardianFormBroadcast["closed"];
  /**
   * Owner-defined state the write may need to read back out of band, for a
   * client with no field to echo it in. Opaque here.
   */
  meta: Record<string, unknown>;
  logContext: Record<string, unknown>;
  /**
   * Set once a submission has been accepted. The form went to every connected
   * client, so more than one can answer it; the first claim wins and the rest
   * write nothing.
   */
  claimed: boolean;
}

const pendingForms = new Map<string, PendingGuardianForm>();

export interface OpenGuardianFormOptions {
  /** Which form this is, for logs and for scoping the open-form check. */
  kind: string;
  broadcast: GuardianFormBroadcast;
  /** How long to hold it open. Defaults to the shared 5 minutes. */
  timeoutMs?: number;
  meta?: Record<string, unknown>;
  /** Form-specific fields folded into this form's log lines. */
  logContext?: Record<string, unknown>;
  /** What the parked call is told when nobody answers. */
  timeoutError?: string;
}

/**
 * Park a call until the guardian answers its form.
 *
 * The returned promise settles exactly once: on an answer, on a dismissal, or
 * on the deadline. It never rejects, because the caller's failure is a result
 * it has to report, not an exception to unwind through.
 */
export function openGuardianForm<TResult extends GuardianFormResult>(
  options: OpenGuardianFormOptions,
): Promise<TResult> {
  const {
    kind,
    broadcast,
    timeoutMs,
    meta = {},
    logContext = {},
    timeoutError = "Prompt timed out",
  } = options;
  const requestId = uuid();

  return new Promise<TResult>((resolve) => {
    const timer = setTimeout(() => {
      const pending = pendingForms.get(requestId);
      if (!pending) {
        return;
      }
      log.warn({ requestId, kind, ...logContext }, "Guardian form timed out");
      expireForm(requestId, pending, timeoutError);
    }, timeoutMs ?? GUARDIAN_FORM_DEFAULT_TIMEOUT_MS);

    pendingForms.set(requestId, {
      kind,
      // The registry knows only the base shape; the owner's extra fields ride
      // through resolveGuardianForm untouched, so the cast is confined here.
      resolve: resolve as (result: GuardianFormResult) => void,
      timer,
      closed: broadcast.closed,
      meta,
      logContext,
      claimed: false,
    });

    broadcast.open(requestId);
    log.info({ requestId, kind, ...logContext }, "Guardian form broadcast");
  });
}

/**
 * End a form nobody answered in time, and tell the clients showing it.
 *
 * Without the broadcast the card stays up offering an answer that would now be
 * refused: a form that has closed accepts no submission.
 */
function expireForm(
  requestId: string,
  pending: PendingGuardianForm,
  error: string,
): void {
  pendingForms.delete(requestId);
  pending.resolve({ ok: false, error });
  pending.closed(requestId, "timed_out");
}

/**
 * Claim a pending form so exactly one submission can write.
 *
 * The daemon holds the only record of which forms are still open, so it is the
 * one place that can decide a race between two clients answering the same
 * broadcast, and the only one that can tell whether an id is even the right
 * form. Pass `expectedKind` whenever the caller knows which form it is
 * writing for. First caller wins; the rest are told why they lost, so the writer
 * can tell "somebody already answered this" (leave their answer alone) apart
 * from "no such form" (expired or already resolved, so nothing should be
 * written at all).
 */
export function claimGuardianForm(
  requestId: string,
  expectedKind?: string,
): {
  claimed: boolean;
  reason?: "already_claimed" | "unknown" | "wrong_kind";
  settleMs?: number;
} {
  const pending = pendingForms.get(requestId);
  if (!pending) {
    return { claimed: false, reason: "unknown" };
  }
  if (expectedKind !== undefined && pending.kind !== expectedKind) {
    // An id alone does not say which form it belongs to. Without this, a
    // submission to form B's endpoint could claim an open form A: B's write
    // would run, and A's parked caller would be handed B's result for a form
    // it never showed.
    log.warn(
      { requestId, expectedKind, actualKind: pending.kind },
      "Guardian form claim rejected: the id belongs to a different form",
    );
    return { claimed: false, reason: "wrong_kind" };
  }
  if (pending.claimed) {
    return { claimed: false, reason: "already_claimed" };
  }
  pending.claimed = true;
  // Answered, so its open-for-answers deadline gives way to a bounded settle
  // window while the write reports back.
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    log.warn(
      { requestId, kind: pending.kind, ...pending.logContext },
      "Guardian form claimed but never settled; the write never reported back",
    );
    expireForm(requestId, pending, "The submitted form never completed");
  }, GUARDIAN_FORM_SETTLE_MS);
  // The claimer needs the window too: it is how long its write has to report
  // back before the caller gives up, and it should not have to know the number
  // independently.
  return { claimed: true, settleMs: GUARDIAN_FORM_SETTLE_MS };
}

/**
 * Hand a form's answer to the call parked on it and retire the card.
 *
 * An error covers a dismissal and a failed write alike: the form is over
 * either way, and the caller is the one told why.
 */
export function resolveGuardianForm<TResult extends GuardianFormResult>(
  requestId: string,
  result: TResult,
): { resolved: boolean } {
  const pending = pendingForms.get(requestId);
  if (!pending) {
    log.warn({ requestId }, "resolve: no pending guardian form found");
    return { resolved: false };
  }

  clearTimeout(pending.timer);
  pendingForms.delete(requestId);
  pending.resolve(result);
  pending.closed(requestId, result.ok ? "answered" : "cancelled");

  log.info(
    { requestId, kind: pending.kind, ...pending.logContext },
    "Guardian form resolved",
  );
  return { resolved: true };
}

/**
 * Whether any form of these kinds is open and still unanswered.
 *
 * Takes the kinds to check rather than sweeping the whole registry. Clients
 * hold one card per kind, so a second broadcast of a kind already on screen
 * replaces the first and leaves its command waiting on a form nobody can
 * answer. A registry-wide check would go further than that and let any pending
 * form block every other one, which is a rule each form should opt into rather
 * than inherit.
 */
export function hasUnclaimedGuardianForm(kinds: readonly string[]): boolean {
  for (const pending of pendingForms.values()) {
    if (!pending.claimed && kinds.includes(pending.kind)) {
      return true;
    }
  }
  return false;
}

/** Owner-defined state parked with a form, for a writer that must read it back. */
export function getGuardianFormMeta(
  requestId: string,
): Record<string, unknown> | undefined {
  return pendingForms.get(requestId)?.meta;
}
