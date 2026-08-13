import fs from "node:fs";

import { parseLockfile, type Lockfile } from "@vellumai/local-mode/contract";

/**
 * Lockfile watcher for the main process. Polls the lockfile's mtime every
 * 500ms and caches the parsed result. Consumers (tray menu, window title)
 * read from the cache instead of hitting disk on every access.
 *
 * Polling mtime (rather than `fs.watch` or `chokidar`) because:
 *   - The lockfile is written via atomic rename (write tmp → rename to path),
 *     which `fs.watch` handles unreliably on macOS (fires twice or misses).
 *   - One `fs.stat` per 500ms on a single file is negligible CPU.
 *   - Zero third-party dependencies.
 *
 * A 100ms debounce prevents double-fires from rapid consecutive writes
 * (e.g. CLI writing multiple assistants in sequence).
 */

type LockfileChangeListener = (lockfile: Lockfile) => void;

const POLL_INTERVAL_MS = 500;
const DEBOUNCE_MS = 100;

const EMPTY_LOCKFILE: Lockfile = { assistants: [], activeAssistant: null };

let lockfileCandidates: string[] = [];
let resolveCandidates: () => readonly string[] = () => [];
let cachedLockfile: Lockfile = EMPTY_LOCKFILE;
let lastMtimeMs = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<LockfileChangeListener>();

const isAccessDenied = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
};

export const configureLockfileWatcher = (
  resolver: () => readonly string[],
): void => {
  resolveCandidates = resolver;
};

/**
 * Parse the first readable candidate lockfile, canonical first. The first
 * readable file is authoritative even when its entry list is empty, matching
 * `readPairedGatewayTargets` in @vellumai/local-mode: an unpair leaves a
 * readable canonical file with the entry removed, so a stale legacy fallback
 * can never resurrect it. The fallback keeps legacy-only installs (no
 * canonical file yet) populated. Returns EMPTY_LOCKFILE when no candidate
 * is readable.
 */
const readAndParse = (): Lockfile | null => {
  for (const candidate of lockfileCandidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      return parseLockfile(JSON.parse(raw));
    } catch (error) {
      if (isAccessDenied(error)) {
        return null;
      }
      // Missing or corrupt, try the next candidate.
    }
  }
  return EMPTY_LOCKFILE;
};

const notifyListeners = (): void => {
  for (const listener of listeners) {
    listener(cachedLockfile);
  }
};

const checkForChanges = (): void => {
  const canonicalPath = lockfileCandidates[0];
  if (!canonicalPath) {
    return;
  }

  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(canonicalPath).mtimeMs;
  } catch (error) {
    if (isAccessDenied(error)) {
      return;
    }
    // Canonical file missing or inaccessible. Fall back to the first
    // readable candidate (legacy-only installs, transient gaps) and go
    // empty only when nothing is readable.
    lastMtimeMs = 0;
    const next = readAndParse();
    if (!next) {
      return;
    }
    if (JSON.stringify(next) !== JSON.stringify(cachedLockfile)) {
      cachedLockfile = next;
      notifyListeners();
    }
    return;
  }

  if (mtimeMs === lastMtimeMs) {
    return;
  }
  // Debounce: atomic rename can produce rapid mtime bumps.
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const next = readAndParse();
    if (!next) {
      return;
    }
    lastMtimeMs = mtimeMs;
    cachedLockfile = next;
    notifyListeners();
  }, DEBOUNCE_MS);
};

/**
 * Return the current cached lockfile. Synchronous — no disk I/O.
 */
export const getWatchedLockfile = (): Lockfile => cachedLockfile;

/**
 * Return the cached lockfile, or null before {@link installLockfileWatcher}
 * has produced a snapshot. Callers with a disk-reading fallback (the
 * app-protocol paired-gateway forward) use the null to cover the startup
 * window where the watcher is not installed yet.
 */
export const getWatchedLockfileSnapshot = (): Lockfile | null =>
  lockfileCandidates.length > 0 ? cachedLockfile : null;

/**
 * Re-read the watched lockfile immediately, bypassing the poll interval and
 * any pending debounce. For lockfile writes performed by this process (e.g.
 * unpair) whose consumers must observe the change in the same tick rather
 * than after the next poll. No-op before the watcher is installed.
 */
export const refreshLockfileNow = (): void => {
  const canonicalPath = lockfileCandidates[0];
  if (!canonicalPath) {
    return;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const previousMtimeMs = lastMtimeMs;
  try {
    lastMtimeMs = fs.statSync(canonicalPath).mtimeMs;
  } catch {
    lastMtimeMs = 0;
  }
  const next = readAndParse();
  if (!next) {
    lastMtimeMs = previousMtimeMs;
    return;
  }
  cachedLockfile = next;
  notifyListeners();
};

/**
 * Subscribe to lockfile changes. The listener fires whenever the lockfile's
 * mtime changes (debounced). Returns an unsubscribe function.
 */
export const onLockfileChange = (
  listener: LockfileChangeListener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Start polling. Call once from `app.whenReady()`. Reads the lockfile
 * immediately on install (synchronous, so the first `buildTrayMenu`
 * has data). Returns a teardown function for `before-quit`.
 */
export const installLockfileWatcher = (): (() => void) => {
  // Poll only the canonical (first) path: write helpers always target
  // candidates[0], so watching a legacy candidate would miss updates once
  // the canonical file is created.
  lockfileCandidates = [...resolveCandidates()];

  // Initial read — synchronous so the tray menu has data from frame one.
  // readAndParse falls back to legacy candidates when the canonical file
  // doesn't exist yet, so pre-migration installs still show data.
  const initial = readAndParse();
  cachedLockfile = initial ?? EMPTY_LOCKFILE;
  if (initial) {
    try {
      lastMtimeMs = fs.statSync(lockfileCandidates[0]!).mtimeMs;
    } catch {
      lastMtimeMs = 0;
    }
  } else {
    lastMtimeMs = 0;
  }

  pollTimer = setInterval(checkForChanges, POLL_INTERVAL_MS);

  return () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    listeners.clear();
  };
};

// Test seam — exported only for unit tests.
export const __resetForTesting = (): void => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  listeners.clear();
  cachedLockfile = EMPTY_LOCKFILE;
  lastMtimeMs = 0;
  lockfileCandidates = [];
  resolveCandidates = () => [];
};
