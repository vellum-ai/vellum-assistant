/**
 * The cross-process side of the conversation processing lock.
 *
 * Agent turns run in more than one process: the daemon runs user turns, and
 * the schedule worker runs wake, workflow and execute schedules that target
 * the same conversations. Each process has its own in-memory flag, so the
 * `conversations.processing_started_at` row is the only place they can see
 * each other. A claim on that row is taken atomically and names the holder's
 * pid, so a second process finds the row held and answers busy instead of
 * starting a second agent loop on the same history.
 *
 * All assistant processes share one pid namespace (one container, or one
 * host), so a holder's liveness is a `kill(pid, 0)` away. A dead holder's
 * claim is taken over; so is one older than the lease ceiling, which covers a
 * pid recycled onto an unrelated process.
 */

/**
 * Longest a claim is honoured without its holder proving alive by pid. Well
 * above any real turn, since a claim past it is taken over even when the pid
 * is alive.
 */
export const PROCESSING_CLAIM_MAX_AGE_MS = 6 * 60 * 60_000;

/** Thrown when another live process holds the conversation's processing claim. */
export class ProcessingHeldElsewhereError extends Error {
  readonly conversationId: string;
  readonly heldByPid: number | null;
  readonly heldSince: number | null;

  constructor(
    conversationId: string,
    heldByPid: number | null,
    heldSince: number | null,
  ) {
    super(
      `Conversation ${conversationId} is processing in another process` +
        (heldByPid != null ? ` (pid ${heldByPid})` : ""),
    );
    this.name = "ProcessingHeldElsewhereError";
    this.conversationId = conversationId;
    this.heldByPid = heldByPid;
    this.heldSince = heldSince;
  }
}

/** Whether `pid` names a live process this one may signal. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM is a live process this one may not signal, which still counts.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
