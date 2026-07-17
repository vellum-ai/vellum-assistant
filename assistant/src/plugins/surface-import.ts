/**
 * Shared low-level import machinery for user-surface files (plugin tools,
 * plugin hooks, and standalone workspace hooks).
 *
 * Both the plugin/tool cache (`mtime-cache.ts`) and the hook cache
 * (`../hooks/hook-loader.ts`) re-import surface files keyed by mtime. This
 * module owns the pieces they share — mtime stat, the per-process import
 * timeout, and a timeout-guarded, concurrency-deduplicated dynamic import —
 * so neither surface duplicates the logic and the import-timeout knob is
 * configured in exactly one place.
 *
 * Kept dependency-light (only the logger and `importDefault`) so it can sit
 * below both caches without introducing an import cycle.
 */

import { statSync } from "node:fs";

import { getLogger } from "../util/logger.js";
import { importDefault } from "./external-plugin-loader.js";

const log = getLogger("surface-import");

/**
 * Per-process upper bound on how long a single surface import may take.
 * Set once at boot by `populateCacheAtBoot`; read by every re-import. A
 * plugin/hook with a hanging top-level `await` is skipped rather than
 * blocking the daemon.
 */
let importTimeoutMs = 10_000;

/** Override the surface import timeout (called once at boot). */
export function setSurfaceImportTimeout(ms: number): void {
  importTimeoutMs = ms;
}

/** Current surface import timeout in milliseconds. */
export function getSurfaceImportTimeout(): number {
  return importTimeoutMs;
}

/**
 * Get the mtimeMs of a file, or 0 if the file doesn't exist or can't be
 * stat'd. Callers treat 0 as "absent" (cache-evict / skip).
 */
export function getMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Composite change signature for a file — `mtimeMs:size:ino` — or `""` when the
 * file is absent or can't be stat'd.
 *
 * Unlike {@link getMtime}, this detects a rewrite even when the filesystem's
 * mtime resolution is too coarse to move the timestamp (or two rewrites land in
 * the same timestamp granule). The source-versions sentinel is published via a
 * temp-file + atomic rename, which swaps in a fresh inode on every write, so
 * `ino` changes even when `mtimeMs` does not — and `size` shifts too whenever
 * the plugin set does. Gating the reconcile on this signature (rather than
 * mtime alone) is what lets a plugin installed at runtime go live on
 * filesystems whose mtime granularity is coarse (virtiofs / 9p / network mounts
 * — the same mounts the plugin-source watcher polls precisely because their
 * timestamps are unreliable) instead of only after the next daemon restart.
 *
 * Change detection only — the exact numbers are never interpreted, so inode
 * values above 2^53 losing float precision cannot cause a missed update: `mtime`
 * and `size` still move on a real publish.
 */
export function getFileSignature(filePath: string): string {
  try {
    const st = statSync(filePath);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return "";
  }
}

/**
 * Evict `filePath` from the runtime module registry so the next dynamic
 * `import()` of that path re-evaluates the file from disk.
 *
 * Bun's CJS and ESM loaders share one module registry, so deleting the
 * `require.cache` entry invalidates `import()` too. This is Node-compat
 * surface — intended behavior per the Bun maintainers
 * (github.com/oven-sh/bun/discussions/10162) but not spec-guaranteed, so it
 * is pinned end-to-end by `../hooks/__tests__/hook-live-reload.test.ts`.
 *
 * Callers must evict only when the file's content actually changed on disk
 * (mtime moved, or the file was deleted and recreated) — evicting on every
 * read would defeat the module cache entirely. Eviction is per-file: modules
 * the evicted file imports stay cached, so an edit to a hook's helper module
 * takes effect only if the helper is evicted as well.
 */
export function evictModule(filePath: string): void {
  delete require.cache[filePath];
}

/**
 * Error a {@link withTimeout} race rejects with when the deadline wins. Named
 * so callers that time-box user code can tell "the wrapped promise took too
 * long" apart from "the wrapped promise itself rejected".
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Reject with a {@link TimeoutError} after `ms` if `p` hasn't settled. The
 * losing promise is abandoned, not cancelled — the caller must treat a timeout
 * as best-effort and swallow any late rejection from the abandoned promise.
 *
 * This is the one place surface paths time-box user code: the surface import
 * itself ({@link importWithTimeout}) and the hook runner's `shutdown`
 * invocation both wrap through here so the deadline logic lives once.
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * In-flight import promises, keyed by file path. Prevents duplicate
 * `import()` calls when multiple readers request the same surface
 * concurrently.
 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Import a module's default export with a timeout. If the import doesn't
 * resolve within `timeoutMs`, logs a warning and returns `undefined` so a
 * hanging module doesn't block daemon startup indefinitely. Defaults to the
 * module-level {@link getSurfaceImportTimeout}. A genuine import failure (not a
 * timeout) propagates so the caller can log and cache it as absent.
 */
export async function importWithTimeout<T>(
  filePath: string,
  timeoutMs: number = importTimeoutMs,
): Promise<T | undefined> {
  const importPromise = importWithDedup<T>(filePath);
  try {
    return await withTimeout<T>(
      importPromise,
      timeoutMs,
      `Import timed out after ${timeoutMs}ms — skipping surface`,
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      importPromise.catch(() => {
        /* swallow — late rejection from abandoned import */
      });
      log.warn(
        { filePath, timeoutMs },
        `Import timed out after ${timeoutMs}ms — skipping surface`,
      );
      return undefined;
    }
    throw err;
  }
}

/**
 * Import a module's default export, deduplicating concurrent imports for
 * the same file path. This prevents two readers from triggering duplicate
 * `import()` calls when they request the same surface simultaneously.
 *
 * Note: Bun caches `import()` by resolved path within a process, so the
 * dedup is about avoiding redundant async work, not cache-busting. A caller
 * that needs a content edit picked up must call {@link evictModule} before
 * re-importing; a bare re-import returns the cached module.
 */
async function importWithDedup<T>(filePath: string): Promise<T> {
  let promise = inflight.get(filePath);
  if (promise === undefined) {
    promise = importDefault<T>(filePath);
    inflight.set(filePath, promise);
  }
  try {
    return (await promise) as T;
  } finally {
    inflight.delete(filePath);
  }
}

/** Clear in-flight import state. Test-only. */
export function clearSurfaceImportInflight(): void {
  inflight.clear();
}
