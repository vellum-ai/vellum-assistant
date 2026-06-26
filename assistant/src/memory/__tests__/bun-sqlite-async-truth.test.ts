/**
 * Is `bun:sqlite` "async mode" truly async?  —  a runnable demonstration.
 *
 * Short answer: **no.** `bun:sqlite` has no async API. Every query method
 * (`.get()`, `.all()`, `.run()`, `.exec()`) is a synchronous native call.
 * Wrapping one in an `async function` / `await` does NOT move the work off
 * the main thread — the SQLite C code still runs to completion in a single
 * event-loop turn, blocking every other piece of I/O (timers, sockets,
 * health checks) for the full duration. The `await` only defers the code
 * *after* it; the query itself is as blocking as ever.
 *
 * This file proves that empirically instead of asserting it from docs. The
 * instrument is a recursive `setImmediate` probe: it re-arms itself on every
 * event-loop iteration, so on a healthy, unblocked loop it ticks tens of
 * thousands of times per second. If the main thread is stuck inside a
 * synchronous native call, the loop cannot turn and the tick count collapses
 * to ~0. The signal is intentionally binary: "many ticks" = the loop was
 * free; "zero ticks" = the loop was blocked.
 *
 * Run it locally:
 *   cd assistant
 *   bun test src/memory/__tests__/bun-sqlite-async-truth.test.ts
 *
 * Watch the console output — it prints the measured tick counts so you can
 * see the difference for yourself, not just trust a green check.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

/**
 * Run `fn` while counting event-loop iterations. Returns how many times the
 * loop turned during `fn` and how long `fn` took. A truly async `fn` (one
 * that yields the thread while it waits) lets the probe rack up ticks; a
 * synchronous blocker starves it.
 */
async function measureEventLoopTicks(
  fn: () => Promise<unknown>,
): Promise<{ ticks: number; ms: number }> {
  let ticks = 0;
  let probing = true;
  const tick = (): void => {
    if (!probing) return;
    ticks += 1;
    setImmediate(tick);
  };
  setImmediate(tick);

  const startMs = Date.now();
  try {
    await fn();
  } finally {
    probing = false;
  }
  return { ticks, ms: Date.now() - startMs };
}

// A pure-CPU SQLite workload: a recursive CTE that counts to N entirely
// inside SQLite's C engine. No table or disk I/O needed, so the cost is all
// synchronous compute on the calling thread — exactly the thing that would
// block the event loop. N is tuned to take well over 100 ms so the contrast
// with the probe is unmistakable on any machine.
const COUNT_TO = 4_000_000;
const HEAVY_QUERY = `WITH RECURSIVE c(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${COUNT_TO}
) SELECT count(*) AS n FROM c`;

describe("bun:sqlite async-mode truth", () => {
  test("control: an awaited timer is truly async — the loop keeps ticking", async () => {
    // Positive control. This proves the probe actually detects a free event
    // loop: `await`-ing a timer yields the thread, so setImmediate fires
    // thousands of times while we wait. If this didn't tick, the instrument
    // itself would be broken and the headline test below would be meaningless.
    const { ticks, ms } = await measureEventLoopTicks(
      () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
    );

    console.log(`[control: awaited setTimeout(200ms)]  ticks=${ticks}  ms=${ms}`);

    expect(ticks).toBeGreaterThan(50);
  });

  test("bun:sqlite wrapped in async/await is NOT truly async — it blocks the loop", async () => {
    const db = new Database(":memory:");

    // The "async mode" a caller might reach for: an async function that
    // `await`s the query. It LOOKS asynchronous at the call site, but
    // `bun:sqlite` runs synchronously, so the event loop is frozen for the
    // entire query.
    const runQueryInAsyncMode = async (): Promise<number> => {
      const row = db.query(HEAVY_QUERY).get() as { n: number };
      return row.n;
    };

    let rowCount = 0;
    const { ticks, ms } = await measureEventLoopTicks(async () => {
      rowCount = await runQueryInAsyncMode();
    });
    db.close();

    console.log(
      `[bun:sqlite awaited in "async mode"]    ticks=${ticks}  ms=${ms}  (counted ${rowCount} rows)`,
    );

    // Sanity: the query did real, measurable work — it wasn't optimized away.
    expect(rowCount).toBe(COUNT_TO);
    expect(ms).toBeGreaterThan(50);

    // The verdict. Because the query is a single synchronous native call, the
    // event loop could not turn even once while it ran. A genuinely async
    // implementation would have let the probe tick hundreds of times (see the
    // control above). At most one straggler tick can land in the await
    // micro-task boundary around the call, so allow <= 1.
    expect(ticks).toBeLessThanOrEqual(1);
  });

  // Affirmative half of the answer: the ONLY way to make a long SQLite
  // statement non-blocking is to run it off the main thread. This repo's
  // `runAsyncSqlite` does it by shelling out to the `sqlite3` CLI. We
  // reproduce that here so you can see the same workload become truly async
  // when (and only when) it leaves the main thread. Skipped when no sqlite3
  // binary is installed.
  const sqlite3Path = Bun.which("sqlite3");

  test.if(!!sqlite3Path)(
    "the same workload off-thread (sqlite3 subprocess) IS truly async",
    async () => {
      const { ticks, ms } = await measureEventLoopTicks(async () => {
        // No DB file argument -> sqlite3 uses a transient in-memory database,
        // so this needs nothing on disk. The query runs in the child process;
        // our event loop is free the whole time.
        const proc = Bun.spawn({
          cmd: [sqlite3Path as string],
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        proc.stdin.write(`${HEAVY_QUERY};\n`);
        await proc.stdin.end();
        const stdoutPromise = new Response(proc.stdout).text();
        await proc.exited;
        await stdoutPromise;
      });

      console.log(
        `[sqlite3 subprocess (off main thread)]  ticks=${ticks}  ms=${ms}`,
      );

      // Off the main thread, the loop turns freely while the query runs —
      // the same "many ticks" signal as the timer control, and the opposite
      // of the in-process bun:sqlite case.
      expect(ticks).toBeGreaterThan(50);
    },
    60_000,
  );
});
