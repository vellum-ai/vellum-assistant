/**
 * Current-SQLite-op registry for event-loop-block attribution.
 *
 * `bun:sqlite` runs synchronously on the daemon's single event-loop thread, so
 * a statement that runs long — or spins on the WAL write-lock up to
 * `busy_timeout` — freezes every other handler for its full duration. The
 * event-loop watchdog (`daemon/event-loop-watchdog.ts`) detects *that* a freeze
 * happened but cannot say *which* operation caused it.
 *
 * This registry lets the hot SQLite paths name the op currently executing on
 * the loop thread. Each op brackets its synchronous work with a mark/clear pair
 * (via {@link withCurrentSqlOp}); the watchdog reads {@link snapshotCurrentSqlOp}
 * when it fires and attributes the block to whatever op is still in flight.
 *
 * Because marks only ever bracket *synchronous* sections (no `await` between a
 * start and its `finally` clear), the marks nest in strict LIFO order. That
 * lets the registry be a fixed-size stack of module-level fields — a couple of
 * array writes and one `performance.now()` per op, zero heap allocation on the
 * hot path, and no work at all unless the watchdog actually snapshots. Nested
 * and re-entrant ops (an outer transaction whose body issues inner statements)
 * are handled by the stack; the innermost frame is the one blocking the loop.
 */

/**
 * Deepest nesting the stack records op labels for. Beyond this the depth
 * counter still tracks so `finally` clears stay balanced, but frames aren't
 * stored — 64 nested synchronous SQLite ops is far past anything realistic.
 */
const MAX_DEPTH = 64;

const opStack: (string | undefined)[] = new Array(MAX_DEPTH).fill(undefined);
const startedAtStack: number[] = new Array(MAX_DEPTH).fill(0);
let depth = 0;

/**
 * Mark `op` as the SQLite operation now executing on the loop thread. Must be
 * paired with exactly one {@link markSqlOpEnd} in a `finally` so it never leaks
 * a stale op. Prefer {@link withCurrentSqlOp}, which pairs them for you.
 */
export function markSqlOpStart(op: string): void {
  if (depth < MAX_DEPTH) {
    opStack[depth] = op;
    startedAtStack[depth] = performance.now();
  }
  depth++;
}

/** Clear the innermost op marked by {@link markSqlOpStart}. */
export function markSqlOpEnd(): void {
  if (depth > 0) {
    depth--;
    // Drop the reference so a completed op can't be read back as "in flight".
    if (depth < MAX_DEPTH) opStack[depth] = undefined;
  }
}

/**
 * Run `fn` with `op` marked as the current SQLite op for the duration of its
 * synchronous execution, clearing the mark in `finally` even if `fn` throws.
 *
 * `fn` is expected to be the synchronous SQLite work: if it returns a promise
 * the mark is cleared as soon as the synchronous portion returns (before the
 * promise settles), because only synchronous work blocks the loop thread.
 */
export function withCurrentSqlOp<R>(op: string, fn: () => R): R {
  markSqlOpStart(op);
  try {
    return fn();
  } finally {
    markSqlOpEnd();
  }
}

export interface CurrentSqlOpSnapshot {
  /** The `op` label of the innermost in-flight SQLite operation. */
  op: string;
  /** How long that op has been running, in ms. */
  ageMs: number;
}

/**
 * Snapshot the innermost in-flight SQLite op, or `null` when none is marked
 * (the block was caused by non-SQLite work — never fabricate an op). `nowMs`
 * is injectable for deterministic tests.
 */
export function snapshotCurrentSqlOp(
  nowMs: number = performance.now(),
): CurrentSqlOpSnapshot | null {
  if (depth === 0) return null;
  const idx = Math.min(depth, MAX_DEPTH) - 1;
  const op = opStack[idx];
  if (op === undefined) return null;
  return { op, ageMs: Math.max(0, nowMs - startedAtStack[idx]) };
}

/** Reset the registry. Test-only — production ops always clear via `finally`. */
export function __resetCurrentSqlOpForTests(): void {
  depth = 0;
  opStack.fill(undefined);
  startedAtStack.fill(0);
}
