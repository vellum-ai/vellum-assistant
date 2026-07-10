/**
 * Retry helper for transient SQLite write contention.
 *
 * SQLite serializes writers at the database level: only one connection holds
 * the write lock at a time. `PRAGMA busy_timeout` makes a contending writer
 * *wait* for the lock, but it cannot rescue a statement that still loses the
 * race (the wait elapses) or a transaction that begins as a reader and then
 * fails to upgrade to a writer — both surface as `SQLITE_BUSY`. Transient disk
 * errors surface as `SQLITE_IOERR`. The only correct recovery for either is to
 * re-run the whole operation, so write paths that several processes contend on
 * (the conversation loop, the scheduler, the memory worker) wrap their writes
 * in {@link withSqliteRetry}.
 *
 * It retries on `SQLITE_BUSY*` / `SQLITE_IOERR*` with jittered backoff; the
 * jitter decorrelates retries across the now-separate worker processes so they
 * don't collide in lockstep. The wrapped function may be sync (a `bun:sqlite`
 * statement) or async — it is always awaited, so the single async signature is
 * the one boundary to port if the storage layer ever moves to an async driver.
 *
 * The wrapped function must be safe to re-run: either a single statement, or a
 * sequence guarded so re-execution is idempotent (e.g. an optimistic-lock
 * `WHERE` clause, or a full `db.transaction(...)` that rolls back atomically on
 * failure). Do not wrap a partial sequence whose earlier statements already
 * committed — a retry would double-apply them.
 */

import { getLogger } from "./logger.js";
import { computeRetryDelay } from "./retry.js";
import { runWithSqliteQueryLabel } from "./sqlite-query-label.js";

const log = getLogger("sqlite-retry");

const DEFAULT_MAX_RETRIES = 3;
/** Base for the jittered backoff; busy_timeout absorbs the bulk of the wait. */
const DEFAULT_BASE_DELAY_MS = 50;

export interface SqliteRetryOptions {
  /**
   * Short identifier for the wrapped operation, used in retry logs. Also
   * published as the ambient SQLite query label while `fn` runs, so any
   * slow-query WARN emitted for a statement inside it is attributed to this
   * name instead of an unattributable stack (a lazy Drizzle query awaited
   * here executes from a microtask; a post-backoff retry runs from a stack
   * that bottoms out in this helper).
   */
  op: string;
  /** Maximum retry attempts after the initial try (default 3). */
  maxRetries?: number;
  /** Base delay in ms for the jittered backoff (default 50). */
  baseDelayMs?: number;
  /** Extra structured fields to include in retry warnings (e.g. an id). */
  context?: Record<string, unknown>;
}

function sqliteErrorCode(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? "";
}

/**
 * Whether an error is a transient SQLite contention/IO error worth retrying.
 * Matches the `SQLITE_BUSY` and `SQLITE_IOERR` families (including their
 * extended-result-code suffixes like `SQLITE_BUSY_SNAPSHOT`).
 */
export function isRetryableSqliteError(err: unknown): boolean {
  const code = sqliteErrorCode(err);
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_IOERR");
}

/**
 * Run a SQLite write (sync or async) with retry on transient contention.
 */
export async function withSqliteRetry<T>(
  fn: () => T | Promise<T>,
  options: SqliteRetryOptions,
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      // The inner await must happen inside the label scope: a lazy thenable
      // (e.g. a Drizzle QueryPromise) executes its statement only when
      // awaited, so assimilating it outside the scope would run the query
      // after the ambient label has already evaporated.
      return await runWithSqliteQueryLabel(options.op, async () => await fn());
    } catch (err) {
      if (attempt < maxRetries && isRetryableSqliteError(err)) {
        log.warn(
          {
            ...options.context,
            op: options.op,
            attempt,
            code: sqliteErrorCode(err),
          },
          "withSqliteRetry: transient SQLite error, retrying",
        );
        await Bun.sleep(computeRetryDelay(attempt, baseDelayMs));
        continue;
      }
      throw err;
    }
  }
}
