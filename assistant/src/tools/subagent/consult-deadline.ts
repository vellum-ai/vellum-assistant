/**
 * A progress-aware deadline for the synchronous advisor consult.
 *
 * A reasoning advisor profile spends most of its window *thinking*, streaming
 * reasoning tokens the whole time. A fixed wall-clock ceiling would cut it off
 * mid-thought, so this aborts only after the consult goes `idleMs` without any
 * streamed token (thinking or text) — i.e. genuine silence — with an absolute
 * `maxMs` backstop so a runaway or looping stream can't block the parent
 * forever.
 *
 * Usage: combine `signal` with the caller's own signal, call `recordProgress()`
 * on every streamed chunk, and `dispose()` once the consult settles.
 */
export interface ConsultDeadline {
  /** Aborts when the idle window lapses or the absolute max elapses. */
  readonly signal: AbortSignal;
  /** Reset the idle window — call on every streamed chunk (thinking or text). */
  recordProgress(): void;
  /** Clear both timers; call once the consult settles (success or failure). */
  dispose(): void;
}

export function createConsultDeadline(opts: {
  idleMs: number;
  maxMs: number;
}): ConsultDeadline {
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const recordProgress = (): void => {
    // Once aborted, don't re-arm — the consult is already being torn down.
    if (controller.signal.aborted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), opts.idleMs);
  };

  // Absolute backstop, independent of streaming progress.
  const maxTimer = setTimeout(() => controller.abort(), opts.maxMs);

  // Arm the idle window immediately so time-to-first-token is bounded too.
  recordProgress();

  const dispose = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(maxTimer);
  };

  return { signal: controller.signal, recordProgress, dispose };
}
