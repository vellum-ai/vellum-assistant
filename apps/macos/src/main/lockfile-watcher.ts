import fs from "node:fs";

import { resolveLockfilePaths } from "@vellumai/local-mode";
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

let lockfilePath: string | null = null;
let cachedLockfile: Lockfile = EMPTY_LOCKFILE;
let lastMtimeMs = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<LockfileChangeListener>();

/**
 * Read and parse the lockfile from the watched path. Falls back to
 * EMPTY_LOCKFILE on any error (file missing, invalid JSON, etc.).
 */
const readAndParse = (): Lockfile => {
  if (!lockfilePath) return EMPTY_LOCKFILE;
  try {
    const raw = fs.readFileSync(lockfilePath, "utf-8");
    return parseLockfile(JSON.parse(raw));
  } catch {
    return EMPTY_LOCKFILE;
  }
};

/**
 * Seed the cache from the first readable candidate. Used only during
 * initial install so that legacy-only installs still populate the cache
 * before the canonical file is created by the first write.
 */
const seedFromExistingCandidate = (candidates: string[]): void => {
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      cachedLockfile = parseLockfile(JSON.parse(raw));
      return;
    } catch {
      // continue
    }
  }
};

const notifyListeners = (): void => {
  for (const listener of listeners) {
    listener(cachedLockfile);
  }
};

const checkForChanges = (): void => {
  if (!lockfilePath) return;

  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockfilePath).mtimeMs;
  } catch {
    // File deleted or inaccessible — if we previously had data, clear it.
    if (cachedLockfile !== EMPTY_LOCKFILE) {
      cachedLockfile = EMPTY_LOCKFILE;
      lastMtimeMs = 0;
      notifyListeners();
    }
    return;
  }

  if (mtimeMs === lastMtimeMs) return;
  lastMtimeMs = mtimeMs;

  // Debounce: atomic rename can produce rapid mtime bumps.
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    cachedLockfile = readAndParse();
    notifyListeners();
  }, DEBOUNCE_MS);
};

/**
 * Return the current cached lockfile. Synchronous — no disk I/O.
 */
export const getWatchedLockfile = (): Lockfile => cachedLockfile;

/**
 * Subscribe to lockfile changes. The listener fires whenever the lockfile's
 * mtime changes (debounced). Returns an unsubscribe function.
 */
export const onLockfileChange = (listener: LockfileChangeListener): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/**
 * Start polling. Call once from `app.whenReady()`. Reads the lockfile
 * immediately on install (synchronous, so the first `buildTrayMenu`
 * has data). Returns a teardown function for `before-quit`.
 */
export const installLockfileWatcher = (): (() => void) => {
  const candidates = resolveLockfilePaths(process.env);

  // Always poll the canonical (first) path — write helpers always target
  // candidates[0], so watching a legacy candidate would miss updates once
  // the canonical file is created.
  lockfilePath = candidates[0]!;

  // Initial read — synchronous so the tray menu has data from frame one.
  try {
    lastMtimeMs = fs.statSync(lockfilePath).mtimeMs;
    cachedLockfile = readAndParse();
  } catch {
    // Canonical file doesn't exist yet — seed cache from any existing
    // candidate (legacy path) so pre-migration installs still show data.
    seedFromExistingCandidate(candidates);
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
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  listeners.clear();
  cachedLockfile = EMPTY_LOCKFILE;
  lastMtimeMs = 0;
  lockfilePath = null;
};
