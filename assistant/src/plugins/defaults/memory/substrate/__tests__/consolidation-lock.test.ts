/**
 * Tests for `substrate/consolidation-lock.ts`.
 *
 * Coverage matrix:
 *   - Free lock → acquired; payload records `<pid> <timestamp>`; the returned
 *     owner token matches the on-disk payload byte-for-byte.
 *   - Held by a live PID within the TTL → refused with the holder string,
 *     and the live holder's file is left in place.
 *   - Holder PID not running → stale takeover.
 *   - Holder older than the TTL despite a live PID (container PID-1
 *     collision) → stale takeover.
 *   - Empty / corrupted payload → stale takeover.
 *   - `releaseLock` removes the file and is a no-op when it is absent.
 *   - Owner-verified release: matching token unlinks; a taken-over lock is
 *     never unlinked; an empty-payload lock (failed payload write) is left
 *     for the stale classifier instead of being unlinked blind.
 *   - `getConsolidationLockPath` resolves the frozen
 *     `.v2-state/consolidation.lock` path.
 *
 * Tests use temp dirs (mkdtemp) and never touch `~/.vellum/`.
 */
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _resetInProcessLockStateForTests,
  getConsolidationLockPath,
  reclaimStaleLock,
  releaseLock,
  STALE_LOCK_TTL_MS,
  tryAcquireLock,
} from "../consolidation-lock.js";

let memoryDir: string;
let lockPath: string;

beforeEach(() => {
  memoryDir = mkdtempSync(join(tmpdir(), "consolidation-lock-test-"));
  lockPath = getConsolidationLockPath(memoryDir);
  // Tests that seed a pre-existing holder write the lock file directly, so
  // the `.v2-state` dir (normally created by `tryAcquireLock` itself) must
  // exist up front.
  mkdirSync(dirname(lockPath), { recursive: true });
  // Each test starts as a fresh process for the one-contender-per-process
  // guard; tests simulating a second process reset explicitly mid-test.
  _resetInProcessLockStateForTests();
});

afterEach(() => {
  rmSync(memoryDir, { recursive: true, force: true });
});

/** Acquire and assert success, returning the owner token. */
function acquireExpectingSuccess(tag?: string): string {
  const result = tryAcquireLock(lockPath, tag);
  if (!result.acquired) {
    throw new Error(`expected acquire to succeed; held by ${result.holder}`);
  }
  return result.ownerToken;
}

describe("getConsolidationLockPath", () => {
  test("resolves the frozen .v2-state/consolidation.lock path", () => {
    expect(lockPath).toBe(join(memoryDir, ".v2-state", "consolidation.lock"));
  });
});

describe("tryAcquireLock", () => {
  test("acquires a free lock and records the holder's PID and timestamp", () => {
    const before = Date.now();
    const ownerToken = acquireExpectingSuccess();

    // The payload is `<pid> <timestamp>` so a crashed run leaves a
    // diagnosable trace, and the returned token is that exact payload so
    // owner verification never depends on reading the file back.
    const payload = readFileSync(lockPath, "utf-8").trim();
    expect(ownerToken).toBe(payload);
    const [pid, timestamp] = payload.split(" ");
    expect(Number.parseInt(pid, 10)).toBe(process.pid);
    expect(Number.parseInt(timestamp, 10)).toBeGreaterThanOrEqual(before);
  });

  test("appends the advisory holder tag after the PID and timestamp", () => {
    const ownerToken = acquireExpectingSuccess("ingest:123");

    const parts = readFileSync(lockPath, "utf-8").trim().split(" ");
    expect(parts).toHaveLength(3);
    expect(Number.parseInt(parts[0], 10)).toBe(process.pid);
    expect(parts[2]).toBe("ingest:123");
    expect(ownerToken).toEndWith(" ingest:123");
  });

  test("refuses with the holder string when held by a live PID within the TTL", () => {
    // GIVEN a lock seeded with the current process's PID and a fresh
    // timestamp, so the liveness probe sees a running holder AND the lock is
    // younger than the stale TTL.
    const holder = `${process.pid} ${Date.now()}`;
    writeFileSync(lockPath, `${holder}\n`);

    // WHEN a second acquire attempts the lock, THEN it reports the holder
    // rather than taking over, AND the live holder's file is untouched.
    expect(tryAcquireLock(lockPath)).toEqual({ acquired: false, holder });
    expect(readFileSync(lockPath, "utf-8")).toBe(`${holder}\n`);
  });

  test("takes over a stale lock whose holder PID is not running", () => {
    // PID 999999 is above every platform's PID range, so the liveness probe
    // reports the holder dead.
    writeFileSync(lockPath, "999999 1700000000000\n");

    acquireExpectingSuccess();

    // The stale file was replaced by this process's own lock.
    expect(readFileSync(lockPath, "utf-8")).toStartWith(`${process.pid} `);
  });

  test("takes over a lock from a live PID once it is older than the TTL (container PID-1 collision)", () => {
    // GIVEN a lock held by a live PID (the current process stands in for the
    // restarted PID-1 daemon) with a timestamp beyond the stale TTL. Without
    // the TTL, the liveness probe alone could never reclaim it.
    const ancient = Date.now() - STALE_LOCK_TTL_MS - 1;
    writeFileSync(lockPath, `${process.pid} ${ancient}\n`);

    acquireExpectingSuccess();
    expect(readFileSync(lockPath, "utf-8")).not.toContain(`${ancient}`);
  });

  test("treats an empty / corrupted payload as stale and takes over", () => {
    // The only writer produces `<pid> <timestamp>`, so an empty file is
    // corruption from a partial write that crashed mid-flush.
    writeFileSync(lockPath, "");

    acquireExpectingSuccess();
    expect(readFileSync(lockPath, "utf-8")).toStartWith(`${process.pid} `);
  });
});

describe("releaseLock", () => {
  test("removes the lock file", () => {
    acquireExpectingSuccess();
    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("is a no-op when the lock file is absent", () => {
    expect(existsSync(lockPath)).toBe(false);
    expect(() => releaseLock(lockPath)).not.toThrow();
  });

  test("owner-verified release empties the lock (inode-bound truncate, never a path unlink)", () => {
    const ownerToken = acquireExpectingSuccess("consolidation");

    releaseLock(lockPath, ownerToken);
    // Released shape: the file remains but its payload is gone. Unlinking by
    // path would reintroduce the compare-then-delete race the fd closes.
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe("");
    // The empty corpse is immediately reclaimable: a fresh acquire succeeds.
    acquireExpectingSuccess("next-run");
  });

  test("owner-verified release refuses to unlink a lock held by a different owner", () => {
    const ownerToken = acquireExpectingSuccess("consolidation");

    // A takeover re-wrote the lock: the original owner's token no longer
    // matches, so its release must be a no-op.
    const newerHolder = `${process.pid} ${Date.now()} consolidation-newer`;
    writeFileSync(lockPath, `${newerHolder}\n`);

    releaseLock(lockPath, ownerToken);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe(newerHolder);
  });

  test("owner-verified release leaves an empty-payload lock in place for the stale classifier", () => {
    // An empty lock file is the on-disk shape of a swallowed payload-write
    // failure in `tryCreate`. The synthesized token can never match it, so
    // the owner-verified release must not unlink it: reclamation belongs to
    // the next acquirer's `unparseable` stale takeover, not to a release
    // whose ownership cannot be proven.
    const ownerToken = acquireExpectingSuccess("consolidation");
    writeFileSync(lockPath, "");

    releaseLock(lockPath, ownerToken);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("owner-verified release is a no-op when the lock is already gone", () => {
    const ownerToken = acquireExpectingSuccess();
    releaseLock(lockPath);
    expect(() => releaseLock(lockPath, ownerToken)).not.toThrow();
  });

  test("REGRESSION: a takeover replacement on a NEW inode is untouchable by the old holder's release", () => {
    // The exact interleaving from review: an owner-verified release can be
    // suspended for an arbitrary interval (GC pause, SIGSTOP, machine sleep)
    // while a stale-TTL takeover replaces the lock. A path-based
    // compare-then-unlink would then delete the replacement. The release is
    // instead inode-bound: the ownership read and the destructive truncate
    // go through one file descriptor, so a suspended releaser can only ever
    // touch the inode whose content matched its own token. Simulate the
    // post-takeover world with a genuinely new inode (unlink + create, the
    // same syscalls takeover uses) and assert the replacement survives
    // byte-for-byte.
    const ownerToken = acquireExpectingSuccess("consolidation");
    unlinkSync(lockPath);
    const newerHolder = `${process.pid} ${Date.now()} consolidation-newer`;
    writeFileSync(lockPath, `${newerHolder}\n`);

    releaseLock(lockPath, ownerToken);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe(`${newerHolder}\n`);
  });

  test("release of an already-released (empty) lock is a quiet no-op", () => {
    const ownerToken = acquireExpectingSuccess("consolidation");
    releaseLock(lockPath, ownerToken);
    expect(readFileSync(lockPath, "utf-8")).toBe("");

    // Idempotent: a second release finds no payload to prove ownership
    // against and leaves the released shape untouched.
    releaseLock(lockPath, ownerToken);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe("");
  });
});

describe("reclaimStaleLock", () => {
  test("reclaims the exact stale lock it observed and clears the path", () => {
    const staleHolder = "999999 1700000000000 crashed-run";
    writeFileSync(lockPath, `${staleHolder}\n`);

    expect(reclaimStaleLock(lockPath, staleHolder)).toBe("reclaimed");
    expect(existsSync(lockPath)).toBe(false);
    // A subsequent create succeeds and no quarantine debris remains.
    acquireExpectingSuccess("next-run");
    expect(
      readdirSync(dirname(lockPath)).filter((f) => f.includes(".reclaim-")),
    ).toEqual([]);
  });

  test("REGRESSION: a reclaimer whose observation is stale cannot delete a live successor lock", () => {
    // The two-reclaimer race from review: R1 and R2 both classify the same
    // stale lock; R1 completes reclaim and installs a fresh lock; R2 then
    // proceeds on its stale observation. With the old unlink-based takeover,
    // R2 deleted R1's fresh lock. The rename quarantine makes R2's reclaim
    // capture the successor, detect the mismatch against its observation,
    // and restore the file atomically via link, same inode and all.
    const staleObservation = "999999 1700000000000 crashed-run";
    const liveSuccessor = `${process.pid} ${Date.now()} consolidation-successor`;
    writeFileSync(lockPath, `${liveSuccessor}\n`);

    expect(reclaimStaleLock(lockPath, staleObservation)).toBe("lost");
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe(`${liveSuccessor}\n`);
    expect(
      readdirSync(dirname(lockPath)).filter((f) => f.includes(".reclaim-")),
    ).toEqual([]);
  });

  test("a reclaimer that lost the rename race deletes nothing and reports gone", () => {
    expect(existsSync(lockPath)).toBe(false);
    expect(reclaimStaleLock(lockPath, "999999 1700000000000")).toBe("gone");
  });

  test("full-acquire integration: takeover of a dead-PID lock still works end to end", () => {
    writeFileSync(lockPath, "999999 1700000000000\n");
    acquireExpectingSuccess();
    expect(readFileSync(lockPath, "utf-8")).toStartWith(`${process.pid} `);
  });

  test("abandoned quarantine debris older than the TTL is swept on acquire", () => {
    const ancient = Date.now() - STALE_LOCK_TTL_MS - 1;
    const debris = `${lockPath}.reclaim-12345-${ancient}-abc123`;
    writeFileSync(debris, "999999 1700000000000\n");

    acquireExpectingSuccess();
    expect(existsSync(debris)).toBe(false);
  });
});

describe("concurrent stale reclaimers (deterministic interleavings)", () => {
  // The production shape: the jobs worker (consolidation) and the daemon
  // (page ingest) are separate OS processes sharing this lock, so two
  // contenders CAN observe the same stale lock and interleave arbitrarily.
  // True simultaneity is nondeterministic, so these tests sequence each
  // contender's steps explicitly through the same functions the real flow
  // uses; every dangerous interleaving reduces to one of these orderings.

  test("contender resuming on a stale observation cannot unseat the winner and reports the CURRENT holder", () => {
    // Interleaving: A and B both read stale lock S. A completes its full
    // takeover and installs a fresh lock. B then resumes with its stale
    // observation of S.
    const staleS = "999999 1700000000000 crashed-run";
    writeFileSync(lockPath, `${staleS}\n`);

    // A: full takeover.
    const tokenA = acquireExpectingSuccess("contender-a");
    expect(readFileSync(lockPath, "utf-8").trim()).toBe(tokenA);

    // B resumes: its reclaim captures A's live lock, detects the mismatch
    // against its stale observation, and restores it untouched.
    expect(reclaimStaleLock(lockPath, staleS)).toBe("lost");
    expect(readFileSync(lockPath, "utf-8").trim()).toBe(tokenA);

    // B's create attempt then reports the winner, read fresh, never the
    // stale observation. B is a different process, so the in-process guard
    // does not apply to it; exercise the file-level path.
    _resetInProcessLockStateForTests();
    const resultB = tryAcquireLock(lockPath, "contender-b");
    expect(resultB).toEqual({ acquired: false, holder: tokenA });
    expect(readFileSync(lockPath, "utf-8").trim()).toBe(tokenA);
  });

  test("reclaim winner suspended before its create loses the wx race cleanly; exactly one contender acquires", () => {
    // Interleaving: A wins the quarantine rename and clears the path, then
    // is suspended before its `wx` create. B arrives, finds the path free,
    // and acquires. A resumes: its create must lose with EEXIST and report
    // B, and nothing A does may delete B's lock.
    const staleS = "999999 1700000000000 crashed-run";
    writeFileSync(lockPath, `${staleS}\n`);

    expect(reclaimStaleLock(lockPath, staleS)).toBe("reclaimed");
    expect(existsSync(lockPath)).toBe(false);

    // B acquires while A is suspended.
    const tokenB = acquireExpectingSuccess("contender-b");

    // A resumes. A is a different process from B (guard does not apply):
    // its continuation is an atomic create attempt, and `wx` cannot replace
    // an existing file, so A loses and reports B's live lock.
    _resetInProcessLockStateForTests();
    const resultA = tryAcquireLock(lockPath, "contender-a");
    expect(resultA).toEqual({ acquired: false, holder: tokenB });
    expect(readFileSync(lockPath, "utf-8").trim()).toBe(tokenB);
  });

  test("REGRESSION (three-contender interleaving): the held-process guard refuses a new contender while the path is quarantine-empty", () => {
    // The reviewed interleaving: reclaimer A has renamed a LIVE successor B
    // into quarantine and is suspended before its link restore, so the
    // shared pathname is momentarily empty. A third contender C must not be
    // able to wx-create there. C can only originate from B's process (the
    // reclaimer's process is pinned inside its synchronous call), and B's
    // process is pinned by the held registry, which refuses WITHOUT
    // consulting the file, so the empty pathname changes nothing.
    const staleS = "999999 1700000000000 crashed-run";
    writeFileSync(lockPath, `${staleS}\n`);

    // Successor B installed and HELD by this process (its takeover of S).
    const tokenB = acquireExpectingSuccess("successor-b");

    // Reclaimer A (another process; the registry does not apply to it):
    // suspended after its rename, before its restore. Path is now empty.
    const quarantine = `${lockPath}.reclaim-999-${Date.now()}-testq`;
    renameSync(lockPath, quarantine);
    expect(existsSync(lockPath)).toBe(false);

    // Contender C from B's process: refused by the guard, nothing created.
    const resultC = tryAcquireLock(lockPath, "contender-c");
    expect(resultC).toEqual({
      acquired: false,
      holder: "held by this process",
    });
    expect(existsSync(lockPath)).toBe(false);

    // A resumes and restores B atomically; B is intact and still exclusive.
    linkSync(quarantine, lockPath);
    unlinkSync(quarantine);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe(tokenB);

    // Only after B releases may this process contend again.
    releaseLock(lockPath, tokenB);
    acquireExpectingSuccess("contender-c-after-release");
  });

  test("held-process guard: a process holding the lock cannot field a second contender until release", () => {
    const tokenB = acquireExpectingSuccess("first");

    const second = tryAcquireLock(lockPath, "second");
    expect(second).toEqual({ acquired: false, holder: tokenB });

    releaseLock(lockPath, tokenB);
    acquireExpectingSuccess("second-after-release");
  });

  test("second reclaimer arriving after the rename gets gone/EEXIST, never a deletion", () => {
    // Interleaving: A and B both observe stale S. A's rename wins and A is
    // mid-flight. B's rename finds the path already moved (ENOENT → gone),
    // so B deleted nothing; whichever contender creates first wins the `wx`
    // race and the other reports it.
    const staleS = "999999 1700000000000 crashed-run";
    writeFileSync(lockPath, `${staleS}\n`);

    expect(reclaimStaleLock(lockPath, staleS)).toBe("reclaimed");
    expect(reclaimStaleLock(lockPath, staleS)).toBe("gone");

    const tokenA = acquireExpectingSuccess("contender-a");
    // B is a different process; exercise the file-level EEXIST path.
    _resetInProcessLockStateForTests();
    const resultB = tryAcquireLock(lockPath, "contender-b");
    expect(resultB).toEqual({ acquired: false, holder: tokenA });
    expect(readFileSync(lockPath, "utf-8").trim()).toBe(tokenA);
  });
});
