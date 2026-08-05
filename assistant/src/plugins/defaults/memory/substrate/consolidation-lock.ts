// SUBSTRATE (v2+v3).
/**
 * Memory substrate: the single-process consolidation lock.
 *
 * Serializes bulk writers of the `memory/` files so two overlapping passes
 * can't fight over the same corpus.
 *
 * The lock is a `wx`-created file at `memory/.v2-state/consolidation.lock`
 * containing the holder's PID + timestamp (plus an optional advisory tag), so
 * a crashed run leaves a diagnosable trace. A stale lock is taken over
 * automatically on the next acquire (single-writer per workspace): when the
 * holder's PID is no longer running, or (because the daemon runs as PID 1 in
 * containers and a restarted daemon collides with the dead holder's PID)
 * when the lock is older than {@link STALE_LOCK_TTL_MS}.
 */

import {
  closeSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { isProcessAlive } from "../host-utils.js";
import { getLogger } from "../logging.js";

const log = getLogger("memory-v2-consolidate");

/**
 * Hard timeout for the consolidation run. Consolidation reads the buffer,
 * rewrites several files, and re-encodes essentials/threads: on a mature
 * corpus a full pass legitimately runs ~20 minutes under cross-process write
 * contention, so the bound leaves headroom above that while still keeping a
 * stuck run from pinning the worker indefinitely. Matches the default
 * `timeouts.backgroundTurnTimeoutSec` budget for heartbeat/background turns.
 * Overrunning it marks the run failed and skips its follow-up jobs (reembeds,
 * v3 maintenance) even though the agent's file edits land, so the bound must
 * comfortably exceed a healthy run's duration.
 */
export const CONSOLIDATION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Age past which a lock held by an apparently-live PID is taken over anyway.
 *
 * The PID-liveness probe alone is not sufficient in containers: the daemon
 * runs as PID 1, so after a container restart `isProcessAlive(1)` reports the
 * NEW daemon as alive even though it is not the process that wrote the lock.
 * PID-1 collision means a lock left behind by a crashed/restarted run can
 * never be declared stale by liveness alone, and consolidation wedges
 * permanently (every scheduled run skips with `locked`).
 *
 * A lock older than this TTL is treated as abandoned regardless of PID
 * liveness. The bound is a large multiple of the run's hard timeout: the
 * lock timestamp is written at acquire time and a run can hold the lock for
 * at most `CONSOLIDATION_TIMEOUT_MS`, so a TTL well above that can never fire
 * against a legitimately in-flight run while still recovering a wedged lock
 * within a couple of scheduled passes.
 */
export const STALE_LOCK_TTL_MS = 4 * CONSOLIDATION_TIMEOUT_MS;

/** The consolidation lock's location under a workspace's `memory/` dir. */
export function getConsolidationLockPath(memoryDir: string): string {
  // FROZEN: `memory/.v2-state/` is a persisted workspace path; never rename.
  return join(memoryDir, ".v2-state", "consolidation.lock");
}

/**
 * Result of a lock acquisition attempt. On success, `ownerToken` is the exact
 * payload written into the lock file (trimmed), synthesized at acquire time
 * rather than read back from disk: a read-back would silently yield no token
 * when the payload write failed (disk full, transient IO error), and a
 * token-less caller would fall back to `releaseLock`'s unconditional unlink,
 * disabling the owner verification precisely when the on-disk state is least
 * trustworthy. With a synthesized token, a lock whose payload never made it
 * to disk simply fails the owner comparison and is left for the stale
 * classifier's `unparseable` takeover instead of being unlinked blind.
 */
export type LockAcquireResult =
  | { acquired: true; ownerToken: string }
  | { acquired: false; holder: string };

/**
 * Atomically create the lock file with `wx` (O_CREAT | O_EXCL) flags. On
 * success returns the owner token to present to `releaseLock`; otherwise
 * returns the current holder string (file contents, typically
 * `pid timestamp`).
 *
 * `holderTag` is an optional advisory suffix appended after the PID and
 * timestamp (payload `<pid> <timestamp> <tag>`) so operators can tell which
 * writer holds the lock; stale classification ignores it.
 *
 * Stale-lock takeover: if the file exists but its holder is stale (PID not
 * running, payload corrupt, or (for the container PID-1 collision) older
 * than the TTL; see {@link holderStaleReason}), reclaim it via
 * {@link reclaimStaleLock} and retry the create exactly once. This recovers
 * automatically from a crashed or restarted daemon that died with the lock
 * held; otherwise every subsequent scheduled consolidation would skip with
 * `locked` indefinitely until an operator manually removed the file. A
 * holder with an unparseable / empty payload is treated as stale: an empty
 * file is the released shape `releaseLock` leaves behind, and any other
 * unparseable payload is corruption from a partial write that crashed.
 *
 * Concurrency: this lock is shared across processes (the jobs worker's
 * consolidation and the daemon's page ingest), so takeover must not assume a
 * single acquirer. Acquisition itself is atomic (`wx`), and reclaim uses
 * rename quarantine so two concurrent reclaimers can never delete each
 * other's freshly installed locks; see {@link reclaimStaleLock}.
 */
export function tryAcquireLock(
  lockPath: string,
  holderTag?: string,
): LockAcquireResult {
  // The workspace migration seeds `memory/.v2-state/`, but tests and
  // ad-hoc workspaces may not have it yet. `mkdirSync({ recursive: true })`
  // is idempotent, so the call is cheap when the dir already exists.
  mkdirSync(dirname(lockPath), { recursive: true });
  cleanupAbandonedQuarantines(lockPath);

  const first = tryCreate(lockPath, holderTag);
  if (first.acquired) {
    return first;
  }
  const staleReason = holderStaleReason(first.holder);
  if (staleReason === null) {
    return first;
  }

  if (staleReason === "unparseable" && first.holder === "unknown") {
    // The normal post-release shape: an owner-verified release empties the
    // file rather than unlinking it (see `releaseLock`), so an empty lock is
    // "released", not a genuine takeover. Reclaim quietly.
    log.debug({ lockPath }, "consolidation: reclaiming released (empty) lock");
  } else {
    log.info(
      { lockPath, holder: first.holder, reason: staleReason },
      "consolidation: taking over stale lock",
    );
  }
  reclaimStaleLock(lockPath, first.holder);
  // Every reclaim outcome funnels into one final atomic create attempt,
  // which is the ONLY way this function ever returns `acquired`:
  // - "reclaimed": this caller cleared exactly the stale file it judged.
  // - "gone": another reclaimer won the rename; nothing was deleted here.
  // - "lost": the lock changed hands between the staleness read and the
  //   reclaim and the live successor was restored untouched.
  // In every case `tryCreate` either wins the `wx` race (at most one caller
  // can, and only while the path is genuinely free) or reports the CURRENT
  // holder read fresh from the file, never the stale observation.
  return tryCreate(lockPath, holderTag);
}

/**
 * Reclaim a stale lock without ever unlinking the shared path.
 *
 * The naive takeover (classify stale, `unlinkSync(lockPath)`, `wx`-create)
 * has a two-reclaimer race: both classify the same stale lock, the first
 * unlinks and installs its fresh lock, and the second's unlink then deletes
 * that FRESH lock, re-enabling overlapping writers. Reachable in production
 * because consolidation (jobs worker) and page ingest (daemon) share this
 * lock across processes.
 *
 * Rename is the atomic delete-with-receipt POSIX offers: exactly one
 * reclaimer wins `renameSync(lockPath, quarantine)` (the loser gets ENOENT
 * and simply falls through to the `wx` create, which deletes nothing), and
 * the winner then holds the disputed file at a private name where it can be
 * inspected without racing anyone:
 *
 * - Quarantined content matches the staleness observation → the reclaimer
 *   removed exactly the file it judged; delete the quarantine and let the
 *   caller `wx`-create.
 * - Mismatch → the path changed hands between the staleness read and the
 *   rename, so the quarantine holds a LIVE successor lock. Restore it with
 *   `linkSync` (atomic create-if-absent, same inode, so the successor's own
 *   fd-bound release still works) and report `lost`.
 *
 * Residual, stated honestly: if the restoring reclaimer is suspended between
 * its rename and its restore while BOTH a successor's lock lives in
 * quarantine AND a third acquirer wx-creates at the freed path, the restore
 * fails EEXIST and the quarantined holder runs unlocked alongside the third
 * acquirer. That window is a few syscalls wide, needs three concurrent
 * contenders on a lock whose acquirers arrive minutes apart, and is logged
 * at error level with the quarantine path preserved for forensics. This is
 * the same accepted-residual class as the stale TTL itself.
 *
 * Exported for tests: passing `observedHolder` explicitly lets the
 * two-reclaimer interleaving be exercised deterministically (a caller whose
 * observation is stale relative to the current file simulates the racing
 * reclaimer).
 */
export function reclaimStaleLock(
  lockPath: string,
  observedHolder: string,
): "reclaimed" | "gone" | "lost" {
  const quarantinePath = `${lockPath}.reclaim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(lockPath, quarantinePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Another reclaimer won the rename. Nothing was deleted; the caller
      // falls through to an ordinary create attempt.
      return "gone";
    }
    log.warn(
      { err, lockPath },
      "consolidation: failed to quarantine stale lock; reporting as locked",
    );
    return "lost";
  }
  let quarantined = "";
  try {
    quarantined = readFileSync(quarantinePath, "utf-8").trim();
  } catch {
    // Unreadable quarantine: treat as matching nothing so the restore path
    // below decides; an unreadable file cannot be proven to be the observed
    // stale lock.
  }
  if ((quarantined || "unknown") === observedHolder) {
    try {
      unlinkSync(quarantinePath);
    } catch {
      // Best-effort: an abandoned quarantine is swept by
      // `cleanupAbandonedQuarantines` on a later acquire.
    }
    return "reclaimed";
  }
  // The path changed hands between the staleness read and the rename: the
  // quarantine holds a live successor's lock. Put it back atomically.
  try {
    linkSync(quarantinePath, lockPath);
    unlinkSync(quarantinePath);
    log.info(
      { lockPath, holder: quarantined },
      "consolidation: reclaim raced a live successor lock; restored it untouched",
    );
  } catch (err) {
    log.error(
      { err, lockPath, quarantinePath, holder: quarantined },
      "consolidation: could not restore a live lock captured during reclaim; its holder may run unguarded (quarantine preserved for forensics)",
    );
  }
  return "lost";
}

/**
 * Sweep quarantine files abandoned by a reclaimer that crashed between its
 * rename and its cleanup. Age-gated on the TTL so an in-flight reclaim's
 * quarantine (alive for microseconds in the normal case) is never touched.
 */
function cleanupAbandonedQuarantines(lockPath: string): void {
  const dir = dirname(lockPath);
  const prefix = `${basename(lockPath)}.reclaim-`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const stampField = entry.slice(prefix.length).split("-")[1];
    const stamp = Number.parseInt(stampField ?? "", 10);
    if (Number.isFinite(stamp) && Date.now() - stamp < STALE_LOCK_TTL_MS) {
      continue;
    }
    try {
      unlinkSync(join(dir, entry));
      log.info(
        { quarantinePath: join(dir, entry) },
        "consolidation: swept abandoned reclaim quarantine",
      );
    } catch {
      // best-effort
    }
  }
}

/**
 * Atomically create the lock file. On success returns the owner token (the
 * payload written, trimmed); on EEXIST returns the holder string read from
 * the file (`"unknown"` if the read itself fails). Rethrows any non-EEXIST
 * errno from `openSync`.
 */
function tryCreate(lockPath: string, holderTag?: string): LockAcquireResult {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    try {
      return {
        acquired: false,
        holder: readFileSync(lockPath, "utf-8").trim() || "unknown",
      };
    } catch {
      return { acquired: false, holder: "unknown" };
    }
  }
  const tagSuffix = holderTag === undefined ? "" : ` ${holderTag}`;
  const payload = `${process.pid} ${Date.now()}${tagSuffix}`;
  try {
    writeSync(fd, `${payload}\n`);
  } catch {
    // Best-effort: the file's existence is the lock. A failed payload write
    // leaves an empty file whose owner comparison can never match, so the
    // holder's release is a no-op and the next acquirer reclaims it via the
    // `unparseable` stale classification.
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best-effort
    }
  }
  return { acquired: true, ownerToken: payload };
}

/**
 * Why a lock holder is considered stale, for diagnosable takeover logs:
 *   - `unparseable`: empty / corrupt payload (partial write from a crash).
 *   - `pid_dead`: the holder's PID is no longer running.
 *   - `expired`: the lock is older than {@link STALE_LOCK_TTL_MS} even though
 *     its PID still appears alive (the PID-1 collision case in containers).
 */
type StaleReason = "unparseable" | "pid_dead" | "expired";

/**
 * Parse a `<pid> <timestamp>` holder payload (see `tryCreate`'s write).
 * Returns `null` when the PID cannot be parsed; a missing/garbled timestamp
 * yields `timestamp: null` so a partial payload still gives us the PID.
 */
function parseHolder(
  holder: string,
): { pid: number; timestamp: number | null } | null {
  const match = /^(\d+)(?:\s+(\d+))?/.exec(holder);
  if (!match) {
    return null;
  }
  const pid = Number.parseInt(match[1], 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  const timestamp =
    match[2] !== undefined ? Number.parseInt(match[2], 10) : null;
  return {
    pid,
    timestamp:
      timestamp !== null && Number.isFinite(timestamp) ? timestamp : null,
  };
}

/**
 * Classify a holder string, returning the reason it is stale or `null` when
 * the lock is held by a live process and must be respected.
 *
 * Takeover triggers, in order:
 *   1. Unparseable / empty / `"unknown"` payload → `unparseable`. The only
 *      writer is `tryCreate`, so corruption is a partial write from a crashed
 *      prior holder, not a live writer mid-flush.
 *   2. PID not running → `pid_dead`. The fast path for a crashed daemon (or a
 *      different process now occupying that PID on a normal host).
 *   3. Lock older than {@link STALE_LOCK_TTL_MS} → `expired`. Required because
 *      the daemon runs as PID 1 in containers: after a restart the new daemon
 *      is also PID 1, so the liveness probe alone reports the holder as alive
 *      forever and could never reclaim an abandoned lock. The TTL is far above
 *      the run's hard timeout, so it never fires against an in-flight run.
 */
function holderStaleReason(holder: string): StaleReason | null {
  const parsed = parseHolder(holder);
  if (parsed === null) {
    return "unparseable";
  }
  if (!isProcessAlive(parsed.pid)) {
    return "pid_dead";
  }
  if (
    parsed.timestamp !== null &&
    Date.now() - parsed.timestamp > STALE_LOCK_TTL_MS
  ) {
    return "expired";
  }
  return null;
}

/**
 * Idempotent release of the lock file. Called from the caller's `finally`
 * block so a crash in the run path doesn't leave the lock stranded. ENOENT is
 * swallowed
 * because the lock may have been released by an operator or never created
 * (acquire failed before reaching the lock-write step).
 *
 * `expectedHolder` makes the release owner-verified AND inode-bound: the lock
 * is opened once, its content is read through that file descriptor, and on a
 * token match it is emptied with `ftruncateSync` through the SAME descriptor.
 * It is never unlinked by path. This is what makes the release atomic with
 * respect to stale-TTL takeover: a path-based compare-then-unlink can be
 * suspended between the two steps (GC pause, SIGSTOP, machine sleep) while a
 * takeover replaces the lock, and the resumed unlink would then delete the
 * NEW holder's file. A descriptor cannot make that mistake. It is bound to
 * the inode whose content matched the caller's token, so if takeover swapped
 * the path at any point the descriptor addresses the old, orphaned inode and
 * the truncate touches nothing anyone else can see. The replacement lock is
 * unreachable from this code path by construction, not by timing.
 *
 * A successfully released lock therefore remains on disk as an EMPTY file.
 * That is deliberate: empty is the `unparseable` stale shape, which the next
 * acquirer reclaims immediately (`tryAcquireLock`'s takeover), so an empty
 * lock is functionally "released". Unlinking the corpse here would reintroduce
 * the path-based race the descriptor just closed.
 *
 * Omitting `expectedHolder` preserves the unconditional unlink for callers
 * that positively own the file (tests, operator tooling).
 */
export function releaseLock(lockPath: string, expectedHolder?: string): void {
  if (expectedHolder !== undefined) {
    let fd: number;
    try {
      fd = openSync(lockPath, "r+");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(
          { err, lockPath },
          "consolidation: failed to open lock for owner-verified release (best-effort)",
        );
      }
      return;
    }
    try {
      const current = readFileSync(fd, "utf-8").trim();
      if (current.length === 0) {
        // Already released (or a swallowed payload write): nothing to prove
        // ownership against, and empty is already the released shape.
        return;
      }
      if (current !== expectedHolder) {
        log.warn(
          { lockPath, expectedHolder, currentHolder: current },
          "consolidation: skipping lock release; lock is now held by a different owner",
        );
        return;
      }
      ftruncateSync(fd, 0);
    } catch (err) {
      log.warn(
        { err, lockPath },
        "consolidation: failed owner-verified lock release (best-effort)",
      );
    } finally {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    log.warn(
      { err, lockPath },
      "consolidation: failed to release lock (best-effort)",
    );
  }
}
