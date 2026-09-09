/**
 * The write half of the guardian-form rail.
 *
 * A form-backed command parks in the daemon and its form goes to every
 * connected client. The client that answers posts here, and this file owns
 * everything around the write that is the same for every form: taking the
 * claim so only one submission lands, reporting the outcome back so the parked
 * call returns, and answering a client that lost the race.
 *
 * A form owner supplies only the write itself.
 */

import { ipcCallAssistant } from "../../ipc/assistant-client.js";
import { getLogger } from "../../logger.js";

const log = getLogger("guardian-form-submit");

/** Fallback settle window when a claim did not carry one. */
const DEFAULT_SETTLE_MS = 180_000;

/** Longest a submission waits on the callback before answering its client. */
const RESOLVE_INLINE_BUDGET_MS = 2_000;

/** A write that could not happen, and the status its client should see. */
export interface GuardianFormWriteFailure {
  error: string;
  status: number;
}

/**
 * What a write reports. `resolution` is merged into the callback the parked
 * call receives; `failure` becomes both the client's response and what the
 * parked call is told went wrong.
 *
 * `requestId` and `error` are the rail's: a resolution carrying either has it
 * overwritten, since one addresses the callback and the other is what makes an
 * outcome a failure.
 */
export type GuardianFormWriteOutcome =
  | { resolution: Record<string, unknown> }
  | { failure: GuardianFormWriteFailure };

interface SubmitGuardianFormBase {
  requestId: string;
  /** Form-specific fields folded into this submission's log lines. */
  logContext?: Record<string, unknown>;
  /**
   * The daemon IPC operations to claim through and report back on. Default to
   * the form-agnostic pair. The contact forms pin their own older names,
   * because the gateway ships separately from the daemon and one running
   * against an older daemon must keep calling what that daemon serves.
   */
  claimOperation?: string;
  resolveOperation?: string;
  /**
   * The form this submission is for. The daemon refuses a claim whose id is
   * holding a different form, so a submission cannot answer somebody else's.
   */
  formKind?: string;
}

/**
 * Either a write or a dismissal, never a maybe-write. An optional callback
 * would let a caller that forgot one report "cancelled" over a form the
 * guardian actually answered.
 */
export type SubmitGuardianFormOptions = SubmitGuardianFormBase &
  (
    | {
        /**
         * Runs once the claim is held. Classify expected failures into
         * `failure` rather than throwing; a throw is caught as a backstop and
         * reported as a 500, which loses the status you meant.
         */
        write: () => Promise<GuardianFormWriteOutcome>;
        cancelled?: never;
      }
    | { cancelled: true; write?: never }
  );

/**
 * Claim the form, run the write, and report the outcome to the parked call.
 *
 * The claim comes first because the form went to every connected client: an
 * answer landing near the deadline must stop that deadline rather than race
 * the write it started, and a second client must not overwrite the answer the
 * guardian gave on the first. A dismissal takes the same claim, so it cannot
 * report "cancelled" over an answer that is already committing.
 */
export async function submitGuardianForm(
  options: SubmitGuardianFormOptions,
): Promise<Response> {
  const {
    requestId,
    logContext = {},
    claimOperation = "guardian_form_claim",
    resolveOperation = "resolve_guardian_form",
    formKind,
  } = options;

  const claim = await claimForm(requestId, claimOperation, formKind);
  if (!claim.claimed) {
    log.warn(
      { requestId, reason: claim.reason, ...logContext },
      "guardian-form: submission did not get the claim",
    );
    return lostClaimResponse(claim.reason);
  }
  // Absolute, and dated from the claim: the window is the daemon's and started
  // running there, so measuring it again after a slow write would retry against
  // a form that has already expired.
  const settleDeadline = Date.now() + (claim.settleMs ?? DEFAULT_SETTLE_MS);

  if (options.cancelled === true) {
    await reportResolution(
      requestId,
      { requestId, error: "Cancelled by user", cancelled: true },
      settleDeadline,
      resolveOperation,
    );
    return Response.json({ accepted: true });
  }

  let outcome: GuardianFormWriteOutcome;
  try {
    outcome = await options.write();
  } catch (err) {
    // Claiming a form takes ownership of ending it, so an unexpected throw
    // still owes the parked call a report: without one the command sits until
    // its settle timer while the client's retry comes back as a duplicate,
    // because the claim is still held.
    log.error(
      { err, requestId, ...logContext },
      "guardian-form: the write threw",
    );
    await reportResolution(
      requestId,
      { requestId, error: "The write failed" },
      settleDeadline,
      resolveOperation,
    );
    return Response.json(
      { accepted: false, error: "The write failed" },
      { status: 500 },
    );
  }

  if ("failure" in outcome) {
    await reportResolution(
      requestId,
      { requestId, error: outcome.failure.error },
      settleDeadline,
      resolveOperation,
    );
    return Response.json(
      { accepted: false, error: outcome.failure.error },
      { status: outcome.failure.status },
    );
  }

  // `requestId` and `error` are the rail's. A result carrying its own id would
  // redirect the callback to a different form or to none, and one carrying an
  // `error` would be read as a failure and reported as a cancellation, both
  // over a write that committed.
  const { error: strayError, ...resolution } = outcome.resolution;
  if (strayError !== undefined) {
    log.warn(
      { requestId, ...logContext },
      "guardian-form: dropped an `error` field from a successful result; the key is reserved",
    );
  }

  await reportResolution(
    requestId,
    { ...resolution, requestId },
    settleDeadline,
    resolveOperation,
  );
  return Response.json({ accepted: true });
}

/**
 * Ask the daemon to claim this form for the caller.
 *
 * A transport failure is a lost claim rather than a granted one: the daemon
 * holds the waiting call, so a write it cannot hear about has nobody to report
 * to. `unreachable` is kept distinct from the daemon's own answers, because a
 * caller that cannot be reached says nothing about whether the form was
 * already answered.
 */
async function claimForm(
  requestId: string,
  operation: string,
  kind: string | undefined,
): Promise<{ claimed: boolean; reason?: string; settleMs?: number }> {
  try {
    const result = await ipcCallAssistant(operation, {
      body: { requestId, kind },
    });
    return result as { claimed: boolean; reason?: string; settleMs?: number };
  } catch (err) {
    log.warn(
      { err, requestId },
      "guardian-form: claim IPC failed; refusing the write",
    );
    return { claimed: false, reason: "unreachable" };
  }
}

/**
 * The response for a claim the caller did not get.
 *
 * A competing claim is success from this client's side: the form it was
 * showing has been answered, and there is nothing for it to fix. Anything else
 * is a failure it needs to see, so its card stays and can be retried: an
 * unreachable assistant means the submission never landed, and an unknown form
 * means nothing is waiting for one.
 */
function lostClaimResponse(reason: string | undefined): Response {
  if (reason === "already_claimed") {
    return Response.json({ accepted: true, duplicate: true });
  }
  if (reason === "unreachable") {
    return Response.json(
      { accepted: false, error: "Could not reach the assistant" },
      { status: 503 },
    );
  }
  return Response.json(
    {
      accepted: false,
      error: "This request is no longer waiting for an answer",
    },
    { status: 409 },
  );
}

/**
 * Report an outcome back to the assistant, retrying until the claimed form's
 * settle window runs out.
 *
 * The write has already happened by the time this runs, so a lost callback is
 * not a lost write: it is a command told its form failed while the contact was
 * created, renamed, or deleted. Retries run to the deadline rather than to a
 * fixed count, which a fast-failing socket would burn through in seconds.
 *
 * The first couple of seconds are awaited so the ordinary case answers the
 * client with the callback already delivered; past that the retries continue
 * on their own, since the client is waiting on a write that is already done.
 *
 * A callback that never lands leaves the command reporting failure over a
 * write that happened. Nothing here can close that gap, so it is logged at
 * error rather than papered over.
 */
async function reportResolution(
  requestId: string,
  body: Record<string, unknown>,
  deadline: number,
  operation: string,
): Promise<void> {
  const inlineUntil = Date.now() + RESOLVE_INLINE_BUDGET_MS;

  const attempt = async (): Promise<boolean> => {
    try {
      const result = await ipcCallAssistant(operation, { body });
      if ((result as { resolved?: boolean }).resolved === false) {
        // The form is gone, so nobody is waiting. Retrying cannot change that.
        log.warn(
          { requestId },
          "guardian-form: resolve found no pending form; the command may already have given up",
        );
      }
      return true;
    } catch (err) {
      log.warn({ err, requestId }, "guardian-form: resolve failed, retrying");
      return false;
    }
  };

  const retryUntilDeadline = async (waitMs: number): Promise<void> => {
    let backoff = waitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, backoff));
      if (Date.now() >= deadline) {
        break;
      }
      if (await attempt()) {
        return;
      }
      backoff = Math.min(backoff * 2, 10_000);
    }
    log.error(
      { requestId, body },
      "guardian-form: could not report a committed write to the assistant; the command will report failure over a write that happened",
    );
  };

  if (await attempt()) {
    return;
  }

  // Inline retries while the client's own wait is still short, then hand the
  // rest to the background so the response is not held for the whole window.
  let backoff = 500;
  while (Date.now() < inlineUntil) {
    await new Promise((resolve) => setTimeout(resolve, backoff));
    if (await attempt()) {
      return;
    }
    backoff = Math.min(backoff * 2, 10_000);
  }
  void retryUntilDeadline(backoff);
}
