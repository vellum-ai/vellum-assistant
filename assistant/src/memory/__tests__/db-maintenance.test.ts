/**
 * Tests for `db-maintenance.ts` (orchestration) and the underlying
 * `db-async-query.ts` abstraction.
 *
 * The contract this PR locks in:
 *   1. `runDbMaintenance` runs `VACUUM` through the async abstraction
 *      — when the `sqlite3` CLI is available, that means a subprocess
 *      and the daemon's main event loop keeps ticking. (The structural
 *      anti-block assertion lives in
 *      `db-async-query.test.ts`; here we focus on orchestration.)
 *   2. The subprocess actually shrinks the on-disk page count when
 *      there's reclaimable space.
 *   3. `maybeRunDbMaintenance` is genuinely async — callers can `await`
 *      it and observe completion.
 *   4. The 24 h interval guard short-circuits a recent re-run.
 *
 * The per-file temp workspace is set up by `test-preload.ts`; tests just
 * dynamic-import the DB modules so they resolve paths under that temp dir.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

const { getSqlite } = await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { deleteMemoryCheckpoint, getMemoryCheckpoint } =
  await import("../checkpoints.js");
const { maybeRunDbMaintenance } = await import("../db-maintenance.js");
const { getLastUserMessageTimestamp } = await import("../conversation-crud.js");
const { getDbPath } = await import("../../util/platform.js");

initializeDb();

const MAINTENANCE_CHECKPOINT_KEY = "db_maintenance:last_run";
const QUIET_PERIOD_MS = 3 * 60 * 60 * 1000;

beforeEach(() => {
  deleteMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY);
  const sqlite = getSqlite();
  sqlite.exec("DELETE FROM messages");
  sqlite.exec("DELETE FROM conversations");
});

/** Insert a message row directly, bypassing indexing/job side effects. */
function insertMessage(role: "user" | "assistant", createdAt: number): void {
  const sqlite = getSqlite();
  const convId = `conv-${createdAt}-${role}`;
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)",
    )
    .run(convId, createdAt, createdAt);
  sqlite
    .prepare(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(`msg-${createdAt}-${role}`, convId, role, "[]", createdAt);
}

/** Inflate the test DB with bloat that VACUUM can reclaim. */
function inflateAndDelete(byteTarget: number): void {
  const sqlite = getSqlite();
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS bloat (id INTEGER PRIMARY KEY, payload BLOB)",
  );
  const pageSize = (
    sqlite.query("PRAGMA page_size").get() as { page_size: number }
  ).page_size;
  const rowsTarget = Math.max(1, Math.ceil(byteTarget / pageSize));
  const payload = new Uint8Array(Math.max(1, pageSize - 64));
  const insert = sqlite.prepare("INSERT INTO bloat (payload) VALUES (?)");
  sqlite.exec("BEGIN");
  for (let i = 0; i < rowsTarget; i++) {
    insert.run(payload);
  }
  sqlite.exec("COMMIT");
  sqlite.exec("DELETE FROM bloat");
  sqlite.exec("DROP TABLE bloat");
  // Force the WAL onto the main DB file so the bloat is visible on disk.
  sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

describe("maybeRunDbMaintenance", () => {
  test("returns a Promise that resolves", async () => {
    const result = maybeRunDbMaintenance();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  test("respects the 24h interval and skips when last run was recent", async () => {
    const now = Date.now();
    const recent = now - 60_000;
    const { setMemoryCheckpoint } = await import("../checkpoints.js");
    setMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY, String(recent));

    await maybeRunDbMaintenance(now);

    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBe(
      String(recent),
    );
  });

  test("stamps the checkpoint after a maintenance run", async () => {
    const now = Date.now();
    await maybeRunDbMaintenance(now);

    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBe(String(now));
  });

  test("VACUUM reclaims pages on a bloated DB", async () => {
    const sqlite = getSqlite();
    sqlite.exec("DROP TABLE IF EXISTS bloat");
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    inflateAndDelete(8 * 1024 * 1024);

    const dbPath = getDbPath();
    // Read page_count from a fresh connection so we observe post-write
    // ground truth without snapshot caching on the main test connection.
    const readPageCount = (): number => {
      const probe = new Database(dbPath, { readonly: true });
      try {
        return (
          probe.query("PRAGMA page_count").get() as { page_count: number }
        ).page_count;
      } finally {
        probe.close();
      }
    };
    const pagesBefore = readPageCount();

    await maybeRunDbMaintenance();

    const pagesAfter = readPageCount();
    expect(pagesAfter).toBeLessThan(pagesBefore);
  }, 60_000);

  test("defers maintenance while the last user message is within the quiet period", async () => {
    /** VACUUM must not fire while the user is active, so a recent user
     *  message keeps maintenance deferred. */
    // GIVEN the user sent a message one minute ago (well within the quiet period)
    const now = Date.now();
    insertMessage("user", now - 60_000);

    // WHEN maintenance is considered
    await maybeRunDbMaintenance(now);

    // THEN it is deferred — the checkpoint is never stamped, so a later idle
    // tick will retry
    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBeNull();
  });

  test("runs maintenance once the quiet period has elapsed since the last user message", async () => {
    /** After the user has been quiet for longer than the quiet period,
     *  maintenance is allowed to run. */
    // GIVEN the last user message is older than the quiet period
    const now = Date.now();
    insertMessage("user", now - (QUIET_PERIOD_MS + 60_000));

    // WHEN maintenance is considered
    await maybeRunDbMaintenance(now);

    // THEN it runs and stamps the checkpoint
    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBe(String(now));
  });

  test("ignores quiet period when no user message exists", async () => {
    /** A fresh install with no user messages must not be blocked from ever
     *  running maintenance. */
    // GIVEN no user messages exist
    const now = Date.now();

    // WHEN maintenance is considered
    await maybeRunDbMaintenance(now);

    // THEN it runs and stamps the checkpoint
    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBe(String(now));
  });

  test("a recent assistant message does not keep maintenance deferred", async () => {
    /** The gate keys off user activity only — background assistant writes
     *  must not postpone maintenance indefinitely. */
    // GIVEN the user has been quiet past the quiet period
    const now = Date.now();
    insertMessage("user", now - (QUIET_PERIOD_MS + 60_000));
    // AND the assistant wrote a message recently
    insertMessage("assistant", now - 60_000);

    // WHEN maintenance is considered
    await maybeRunDbMaintenance(now);

    // THEN it still runs, since only user activity gates it
    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBe(String(now));
  });
});

describe("getLastUserMessageTimestamp", () => {
  test("returns 0 when no user message exists", () => {
    /** With only non-user rows present, there is no user activity to report. */
    // GIVEN only an assistant message exists
    insertMessage("assistant", Date.now());

    // WHEN the last user message timestamp is read
    const result = getLastUserMessageTimestamp();

    // THEN it reports 0 (no user activity)
    expect(result).toBe(0);
  });

  test("returns the most recent user message by timestamp, ignoring assistant rows", () => {
    /** The lookup reports the newest user-message timestamp and must skip
     *  non-user rows even when they are more recent. */
    // GIVEN two user messages and a newer assistant message
    const base = Date.now();
    insertMessage("user", base - 10_000);
    insertMessage("user", base - 5_000);
    insertMessage("assistant", base);

    // WHEN the last user message timestamp is read
    const result = getLastUserMessageTimestamp();

    // THEN it returns the most recent user message, not the assistant row
    expect(result).toBe(base - 5_000);
  });

  test("reports the newest user timestamp even when an older turn was inserted later", () => {
    /** `forkConversation` copies a parent's user turns into the fork with
     *  their original (older) `created_at` but fresh row ids, so insertion
     *  order can place an old turn last. The lookup must key off `created_at`
     *  so a fork can't make recent activity look stale and prematurely
     *  un-gate maintenance. */
    // GIVEN a recent user message
    const base = Date.now();
    insertMessage("user", base - 5_000);
    // AND a later insert of an older user turn (as a fork copy would produce)
    insertMessage("user", base - 60 * 60 * 1000);

    // WHEN the last user message timestamp is read
    const result = getLastUserMessageTimestamp();

    // THEN it reports the genuinely most recent turn, not the last-inserted one
    expect(result).toBe(base - 5_000);
  });
});
