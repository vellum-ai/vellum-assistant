/**
 * Tests for `db-maintenance.ts` (orchestration) and the underlying
 * `db-async-query.ts` abstraction.
 *
 * The contract this locks in:
 *   1. `runDbMaintenance` runs `PRAGMA optimize` through the async
 *      abstraction and then truncates the WAL on the daemon connection.
 *      It intentionally does NOT run a full VACUUM (which in WAL mode
 *      inflates the WAL to ~the DB size and needs ~2x the DB size free).
 *   2. The truncating checkpoint shrinks the WAL file once it has grown.
 *   3. `maybeRunDbMaintenance` is genuinely async — callers can `await`
 *      it and observe completion.
 *   4. The 24 h interval guard short-circuits a recent re-run.
 *
 * The per-file temp workspace is set up by `test-preload.ts`; tests just
 * dynamic-import the DB modules so they resolve paths under that temp dir.
 */
import { existsSync, statSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";

const { getSqlite } = await import("../../../../persistence/db-connection.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");
const { deleteMemoryCheckpoint, getMemoryCheckpoint } =
  await import("../../../../persistence/checkpoints.js");
const { maybeRunDbMaintenance, maybeRunPassiveWalCheckpoint } =
  await import("../../../../persistence/db-maintenance.js");
const { getLastInteractiveUserMessageTimestamp } =
  await import("../../../../persistence/conversation-crud.js");
const { getDbPath } = await import("../../../../util/platform.js");

await initializeDb();

const MAINTENANCE_CHECKPOINT_KEY = "db_maintenance:last_run";
const PASSIVE_CHECKPOINT_KEY = "db_maintenance:last_passive_checkpoint";
const QUIET_PERIOD_MS = 3 * 60 * 60 * 1000;

beforeEach(() => {
  deleteMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY);
  deleteMemoryCheckpoint(PASSIVE_CHECKPOINT_KEY);
  const sqlite = getSqlite();
  sqlite.exec("DELETE FROM messages");
  sqlite.exec("DELETE FROM conversations");
});

/** Insert a message row directly, bypassing indexing/job side effects. */
function insertMessage(
  role: "user" | "assistant",
  createdAt: number,
  conversationType: "standard" | "background" | "scheduled" = "standard",
): void {
  const sqlite = getSqlite();
  const convId = `conv-${createdAt}-${role}-${conversationType}`;
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO conversations (id, created_at, updated_at, conversation_type) VALUES (?, ?, ?, ?)",
    )
    .run(convId, createdAt, createdAt, conversationType);
  sqlite
    .prepare(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      `msg-${createdAt}-${role}-${conversationType}`,
      convId,
      role,
      "[]",
      createdAt,
    );
}

/** Pile writes into the WAL (without checkpointing) so a truncating
 *  checkpoint has measurable work to do. */
function inflateWal(byteTarget: number): void {
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
  // Commit, but do not checkpoint — the frames stay in the WAL, leaving it at
  // its high-water mark (a PASSIVE auto-checkpoint resets the WAL for reuse but
  // never shrinks the file). Maintenance is what should truncate it.
  sqlite.exec("COMMIT");
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
    const { setMemoryCheckpoint } =
      await import("../../../../persistence/checkpoints.js");
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

  test("truncates a bloated WAL", async () => {
    const sqlite = getSqlite();
    sqlite.exec("DROP TABLE IF EXISTS bloat");
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    const walPath = `${getDbPath()}-wal`;
    const walSize = (): number =>
      existsSync(walPath) ? statSync(walPath).size : 0;

    inflateWal(4 * 1024 * 1024);
    // Sanity: the writes really did grow the WAL on disk.
    expect(walSize()).toBeGreaterThan(1024 * 1024);

    await maybeRunDbMaintenance();

    // Maintenance truncates the WAL back down (no VACUUM, so the data is folded
    // into the main file rather than rebuilt).
    expect(walSize()).toBeLessThan(64 * 1024);

    sqlite.exec("DROP TABLE IF EXISTS bloat");
  }, 60_000);

  test("defers maintenance while the last user message is within the quiet period", async () => {
    /** Maintenance must not fire while the user is active, so a recent user
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

  test("a recent user-role message in a background conversation does not keep maintenance deferred", async () => {
    /** Background machinery persists user-role rows of its own — the
     *  memory-retrospective instruction message lands as `role: "user"` in a
     *  `background` conversation, and scheduled wake hints land in
     *  `scheduled` ones. On an always-on install those arrive around the
     *  clock, so counting them would starve maintenance forever. */
    // GIVEN the human has been quiet past the quiet period
    const now = Date.now();
    insertMessage("user", now - (QUIET_PERIOD_MS + 60_000));
    // AND background machinery wrote user-role rows just now
    insertMessage("user", now - 60_000, "background");
    insertMessage("user", now - 30_000, "scheduled");

    // WHEN maintenance is considered
    await maybeRunDbMaintenance(now);

    // THEN it still runs — only interactive-conversation activity gates it
    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBe(String(now));
  });
});

describe("maybeRunPassiveWalCheckpoint", () => {
  test("runs despite recent user activity — the passive pass has no quiet gate", async () => {
    /** PASSIVE checkpoints block no readers or writers, so they must not be
     *  deferred by user activity; deferring them is what lets the WAL
     *  backlog grow on always-active installs. */
    // GIVEN the user is active right now
    const now = Date.now();
    insertMessage("user", now - 1_000);

    // WHEN the passive pass is considered
    await maybeRunPassiveWalCheckpoint(now);

    // THEN it runs and stamps its own checkpoint key
    expect(getMemoryCheckpoint(PASSIVE_CHECKPOINT_KEY)).toBe(String(now));
    // AND the truncating-maintenance key is untouched
    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBeNull();
  });

  test("respects its own interval and skips when the last pass was recent", async () => {
    const now = Date.now();
    const recent = now - 60_000;
    const { setMemoryCheckpoint } =
      await import("../../../../persistence/checkpoints.js");
    setMemoryCheckpoint(PASSIVE_CHECKPOINT_KEY, String(recent));

    await maybeRunPassiveWalCheckpoint(now);

    expect(getMemoryCheckpoint(PASSIVE_CHECKPOINT_KEY)).toBe(String(recent));
  });
});

describe("applyConnectionPragmas", () => {
  test("sets journal_size_limit so WAL resets shrink the file", () => {
    /** Checkpointing alone never shrinks the WAL file; the size limit is what
     *  truncates it back after a burst. Pin that every connection carries it. */
    const sqlite = getSqlite();
    const row = sqlite.query("PRAGMA journal_size_limit").get() as {
      journal_size_limit: number;
    };
    expect(row.journal_size_limit).toBe(67108864);
  });
});

describe("getLastInteractiveUserMessageTimestamp", () => {
  test("returns 0 when no user message exists", () => {
    /** With only non-user rows present, there is no user activity to report. */
    // GIVEN only an assistant message exists
    insertMessage("assistant", Date.now());

    // WHEN the last user message timestamp is read
    const result = getLastInteractiveUserMessageTimestamp();

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
    const result = getLastInteractiveUserMessageTimestamp();

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
    const result = getLastInteractiveUserMessageTimestamp();

    // THEN it reports the genuinely most recent turn, not the last-inserted one
    expect(result).toBe(base - 5_000);
  });

  test("ignores user-role rows in background and scheduled conversations", () => {
    /** The memory-retrospective instruction message is persisted as
     *  `role: "user"` inside a `background` fork, and scheduled/heartbeat
     *  wake hints land in `scheduled`/`background` conversations — machine
     *  writes, not human activity. */
    // GIVEN an older interactive user message
    const base = Date.now();
    insertMessage("user", base - 10_000);
    // AND newer user-role rows written by background machinery
    insertMessage("user", base - 5_000, "background");
    insertMessage("user", base - 1_000, "scheduled");

    // WHEN the last interactive user message timestamp is read
    const result = getLastInteractiveUserMessageTimestamp();

    // THEN only the interactive conversation's message counts
    expect(result).toBe(base - 10_000);
  });
});
