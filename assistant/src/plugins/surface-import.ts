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
 * In-flight import promises, keyed by file path. Prevents duplicate
 * `import()` calls when multiple readers request the same surface
 * concurrently.
 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Import a module's default export with a timeout. If the import doesn't
 * resolve within `timeoutMs`, logs a warning and returns `undefined` so a
 * hanging module doesn't block daemon startup indefinitely. Defaults to the
 * module-level {@link getSurfaceImportTimeout}.
 */
export async function importWithTimeout<T>(
  filePath: string,
  timeoutMs: number = importTimeoutMs,
): Promise<T | undefined> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutSentinel = Symbol("import-timeout");
    const importPromise = importWithDedup<T>(filePath);
    const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(timeoutSentinel), timeoutMs);
    });
    const result = await Promise.race([importPromise, timeoutPromise]);
    if (result === timeoutSentinel) {
      importPromise.catch(() => {
        /* swallow — late rejection from abandoned import */
      });
      log.warn(
        { filePath, timeoutMs },
        `Import timed out after ${timeoutMs}ms — skipping surface`,
      );
      return undefined;
    }
    return result as T;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/**
 * Import a module's default export, deduplicating concurrent imports for
 * the same file path. This prevents two readers from triggering duplicate
 * `import()` calls when they request the same surface simultaneously.
 *
 * Note: Bun caches `import()` by resolved path within a process and does not
 * bust on query-string or hash changes, so the dedup is about avoiding
 * redundant async work, not cache-busting. A content edit to an existing
 * file is only picked up after a process restart (added and removed files
 * are picked up live, since discovery is by directory listing).
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
