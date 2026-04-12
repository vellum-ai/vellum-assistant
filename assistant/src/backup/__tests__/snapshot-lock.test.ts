/**
 * Tests for the cross-process snapshot lock helper. Each test gets a fresh
 * temp directory so runs never collide with the real `~/.vellum/backups`
 * directory and so parallel test workers never see each other's lock files.
 *
 * The interesting corners covered here are:
 *   - Acquire → release round-trip leaves the filesystem clean
 *   - A second acquire against a held lock throws with the expected prefix
 *   - A dead-PID lock file (simulated by writing a garbage PID that is not
 *     alive on this host) is taken over transparently
 *   - The release function is idempotent — calling it twice is a no-op
 *   - The lock file is created with mode `0o600` so an unprivileged
 *     peer on the same machine cannot read the holder PID
 *   - **TOCTOU mutual exclusion**: two concurrent acquires against a stale
 *     lock end up with exactly one winner (no double-acquire, no lost lock)
 *   - **Rename-aside**: takeover does not unlink-then-reacquire, so an
 *     interleaved second acquirer cannot destroy the fresh lock
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { acquireSnapshotLock } from "../snapshot-lock.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let ROOT: string;
let LOCK: string;

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "vellum-snapshot-lock-"));
  LOCK = join(ROOT, ".snapshot.lock");
});

afterEach(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("acquireSnapshotLock — happy path", () => {
  test("acquire creates the lock file; release removes it", async () => {
    expect(existsSync(LOCK)).toBe(false);

    const release = await acquireSnapshotLock(LOCK);
    expect(existsSync(LOCK)).toBe(true);

    await release();
    expect(existsSync(LOCK)).toBe(false);
  });

  test("lock file is created with mode 0o600", async () => {
    const release = await acquireSnapshotLock(LOCK);
    try {
      const stats = statSync(LOCK);
      // mask to permission bits only
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await release();
    }
  });

  test("acquire creates the parent directory if missing", async () => {
    // Point the lock at a nested path whose parent does not exist yet so
    // we exercise the mkdir-on-demand code path.
    const nested = join(ROOT, "missing-parent", ".snapshot.lock");
    expect(existsSync(join(ROOT, "missing-parent"))).toBe(false);

    const release = await acquireSnapshotLock(nested);
    try {
      expect(existsSync(nested)).toBe(true);
    } finally {
      await release();
    }
  });
});

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

describe("acquireSnapshotLock — conflicts", () => {
  test("two acquires against a live holder: second throws 'snapshot in progress'", async () => {
    const release = await acquireSnapshotLock(LOCK);
    try {
      await expect(acquireSnapshotLock(LOCK)).rejects.toThrow(
        /snapshot in progress/,
      );
    } finally {
      await release();
    }
  });

  test("conflict error includes the holder PID", async () => {
    const release = await acquireSnapshotLock(LOCK);
    try {
      await expect(acquireSnapshotLock(LOCK)).rejects.toThrow(
        new RegExp(`snapshot in progress \\(locked by pid ${process.pid}\\)`),
      );
    } finally {
      await release();
    }
  });
});

// ---------------------------------------------------------------------------
// Stale-lock takeover
// ---------------------------------------------------------------------------

describe("acquireSnapshotLock — stale locks", () => {
  test("dead PID: acquire takes over and creates a fresh lock", async () => {
    // PID 2^31 - 1 is virtually guaranteed to be dead on any sane host —
    // the platform PID_MAX is typically much smaller. Writing it as the
    // lock holder simulates a crashed prior writer whose process has since
    // exited without releasing.
    const deadPid = 2_147_483_647;
    writeFileSync(LOCK, `${deadPid} ${Date.now()}\n`, { mode: 0o600 });
    expect(existsSync(LOCK)).toBe(true);

    const release = await acquireSnapshotLock(LOCK);
    try {
      expect(existsSync(LOCK)).toBe(true);
    } finally {
      await release();
    }
    expect(existsSync(LOCK)).toBe(false);
  });

  test("unparseable lock file: acquire takes it over", async () => {
    // A lock file that contains garbage (no digits) has no recoverable
    // holder PID — treat it as stale and take over.
    writeFileSync(LOCK, "not a pid at all\n", { mode: 0o600 });

    const release = await acquireSnapshotLock(LOCK);
    try {
      expect(existsSync(LOCK)).toBe(true);
    } finally {
      await release();
    }
    expect(existsSync(LOCK)).toBe(false);
  });

  test("empty lock file: acquire takes it over", async () => {
    writeFileSync(LOCK, "", { mode: 0o600 });

    const release = await acquireSnapshotLock(LOCK);
    try {
      expect(existsSync(LOCK)).toBe(true);
    } finally {
      await release();
    }
    expect(existsSync(LOCK)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Release semantics
// ---------------------------------------------------------------------------

describe("acquireSnapshotLock — release", () => {
  test("release is idempotent: calling twice is safe", async () => {
    const release = await acquireSnapshotLock(LOCK);
    await release();
    // Second call must not throw, even though the file is already gone.
    await release();
    expect(existsSync(LOCK)).toBe(false);
  });

  test("release tolerates an externally-unlinked lock file", async () => {
    const release = await acquireSnapshotLock(LOCK);
    // Simulate another process (or a rogue admin) removing our lock file
    // out from under us. Release must still return without throwing.
    rmSync(LOCK, { force: true });
    await release();
  });

  test("after release, the lock can be acquired again", async () => {
    const release1 = await acquireSnapshotLock(LOCK);
    await release1();

    const release2 = await acquireSnapshotLock(LOCK);
    try {
      expect(existsSync(LOCK)).toBe(true);
    } finally {
      await release2();
    }
  });
});

// ---------------------------------------------------------------------------
// TOCTOU / race safety — regression tests for the rename-aside takeover fix
// ---------------------------------------------------------------------------

describe("acquireSnapshotLock — TOCTOU mutual exclusion", () => {
  test("sequential stale-takeover calls: first wins, second sees the fresh lock", async () => {
    // Two sequential takeover attempts against the same stale lock. The
    // first caller wins via rename-aside and holds the fresh lock. The
    // second caller observes the fresh lock (owned by process.pid) and
    // must throw "snapshot in progress (locked by pid <process.pid>)"
    // — not quietly unlink-and-reacquire.
    const deadPid = 2_147_483_647;
    writeFileSync(LOCK, `${deadPid} ${Date.now()}\n`, { mode: 0o600 });

    const release1 = await acquireSnapshotLock(LOCK);
    try {
      // The fresh lock exists and belongs to this process.
      expect(existsSync(LOCK)).toBe(true);
      // A second acquire must see the fresh lock — not the dead one — and
      // refuse takeover because the holder is alive (process.pid === our pid).
      await expect(acquireSnapshotLock(LOCK)).rejects.toThrow(
        new RegExp(`snapshot in progress \\(locked by pid ${process.pid}\\)`),
      );
    } finally {
      await release1();
    }
    expect(existsSync(LOCK)).toBe(false);
  });

  test("Promise.all of two stale-takeover attempts: exactly one wins", async () => {
    // Proof-of-fix for the original TOCTOU race:
    //
    // Before the fix, two processes observing the same stale lock would
    // both call unlinkSync and both succeed at O_EXCL — ending up with
    // independent beliefs that they hold the lock. The rename-aside pattern
    // makes the takeover atomic: only one rename wins, and the loser
    // retries the acquire loop and sees the winner's fresh lock.
    //
    // We can't literally race two processes in a unit test, but within a
    // single process we can stress the same event-loop interleaving via
    // Promise.all. The assertion is: one succeeds, one throws with the
    // expected prefix, and the winner's PID is the live process.
    const deadPid = 2_147_483_647;
    writeFileSync(LOCK, `${deadPid} ${Date.now()}\n`, { mode: 0o600 });

    const results = await Promise.allSettled([
      acquireSnapshotLock(LOCK),
      acquireSnapshotLock(LOCK),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    // Exactly one winner, exactly one loser. Mutual exclusion holds.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser's error must start with the documented "snapshot in progress"
    // prefix so the HTTP 409 mapping in backup-routes.ts picks it up.
    const err = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(err.message).toMatch(/^snapshot in progress/);

    // The winning acquire returned a release function — make sure we clean up.
    const release = (fulfilled[0] as PromiseFulfilledResult<() => Promise<void>>)
      .value;
    await release();
    expect(existsSync(LOCK)).toBe(false);
  });

  test("live PID in a stale lock refuses takeover", async () => {
    // Regression test for "take over too aggressively": if the lock file's
    // holder PID is ALIVE (e.g. the current process for this test), the
    // takeover path must not fire. This also catches any reversed alive /
    // dead-check logic in the stale-takeover branch.
    writeFileSync(LOCK, `${process.pid} ${Date.now()}\n`, { mode: 0o600 });
    try {
      await expect(acquireSnapshotLock(LOCK)).rejects.toThrow(
        new RegExp(`snapshot in progress \\(locked by pid ${process.pid}\\)`),
      );
      // The pre-existing lock must still be there.
      expect(existsSync(LOCK)).toBe(true);
    } finally {
      // Clean up the hand-rolled lock file so afterEach's rmSync doesn't
      // collide with a leftover fd.
      try {
        rmSync(LOCK, { force: true });
      } catch {
        // best-effort
      }
    }
  });

  test("zero-length lock file from partial write is handled without corruption", async () => {
    // Simulates the "partial write" window: another process has created
    // the lock via O_EXCL but has not yet written the payload. The inspector
    // sees an empty file. After retrying, the file is still empty (the
    // hypothetical writer crashed between open and write). We treat it as
    // stale and take it over via rename-aside.
    writeFileSync(LOCK, "", { mode: 0o600 });
    expect(statSync(LOCK).size).toBe(0);

    const release = await acquireSnapshotLock(LOCK);
    try {
      expect(existsSync(LOCK)).toBe(true);
      // Must contain our PID after takeover, not be empty.
      const { readFileSync } = await import("node:fs");
      const contents = readFileSync(LOCK, "utf-8");
      expect(contents).toMatch(new RegExp(`^${process.pid} `));
    } finally {
      await release();
    }
  });

  test("rename-aside sideband file is cleaned up after takeover", async () => {
    // After a successful stale takeover, no `.snapshot.lock.stale.*` debris
    // should remain in the parent directory — the takeover unlinks the
    // sideband file after the fresh lock is in place. This asserts the
    // cleanup path is wired up so we don't accumulate orphaned files on
    // every crash.
    const deadPid = 2_147_483_647;
    writeFileSync(LOCK, `${deadPid} ${Date.now()}\n`, { mode: 0o600 });

    const release = await acquireSnapshotLock(LOCK);
    try {
      const entries = readdirSync(ROOT);
      // Only the fresh lock file should remain; no `.stale.*` sidebands.
      const sidebandLeftover = entries.filter((e) => e.includes(".stale."));
      expect(sidebandLeftover).toEqual([]);
    } finally {
      await release();
    }
  });
});
