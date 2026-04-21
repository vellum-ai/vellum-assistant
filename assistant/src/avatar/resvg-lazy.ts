import type { Resvg as ResvgType } from "@resvg/resvg-js";

import { getLogger } from "../util/logger.js";

const log = getLogger("resvg-lazy");

type ResvgLoadResult =
  | { available: true; Resvg: typeof ResvgType }
  | { available: false; error: Error };

let cached: ResvgLoadResult | undefined;

function loadResvg(): ResvgLoadResult {
  try {
    // Inline require is necessary here: @resvg/resvg-js loads a platform-specific
    // native .node addon at import time. A top-level import would crash the daemon
    // on startup inside bun --compile binaries where native addons are unavailable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@resvg/resvg-js") as typeof import("@resvg/resvg-js");
    return { available: true, Resvg: mod.Resvg };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // Log once at warn level (not error) — the daemon should keep running and
    // callers should fall back to a non-native path (ASCII only, or a 503 at
    // the HTTP layer). Emitting at error level would page Sentry on every
    // install that skipped the platform-specific optional dependency.
    log.warn(
      {
        err: error,
        platform: process.platform,
        arch: process.arch,
        module: `@resvg/resvg-js-${process.platform}-${process.arch}`,
      },
      "Failed to load @resvg/resvg-js native module — avatar PNG rendering will be unavailable. " +
        "The platform-specific optional dependency is likely missing.",
    );
    return { available: false, error };
  }
}

function getLoadResult(): ResvgLoadResult {
  if (!cached) {
    cached = loadResvg();
  }
  return cached;
}

/**
 * Returns `true` if the native @resvg/resvg-js binding loaded successfully on
 * first access. Callers should check this before calling `getResvg()` and fall
 * back to a non-native path (e.g. ASCII-only rendering, or a 503 at the HTTP
 * layer) when it is `false`.
 *
 * Loading is attempted lazily on first access and the result is cached, so
 * calling this multiple times is cheap and does not re-emit warnings.
 */
export function isResvgAvailable(): boolean {
  return getLoadResult().available;
}

/**
 * Returns the Resvg constructor, loading the native module on first call.
 * Defers the native-addon require so the daemon can start even when the
 * platform-specific binary is unavailable (e.g. inside a bun --compile
 * single-file executable).
 *
 * Throws if the native module could not be loaded. Callers that need to
 * degrade gracefully should check `isResvgAvailable()` first.
 */
export function getResvg(): typeof ResvgType {
  const result = getLoadResult();
  if (!result.available) {
    throw result.error;
  }
  return result.Resvg;
}

/**
 * Test-only hook to reset the cached load result between test cases. Do not
 * call from production code.
 */
export function __resetResvgCacheForTests(): void {
  cached = undefined;
}

/**
 * Test-only hook to force the cached load result to a specific state without
 * exercising the real `require`. Useful for asserting the unavailable path
 * without depending on Bun's module-mock behavior (which re-imports the real
 * module after the factory throws once).
 */
export function __setResvgCacheForTests(result: ResvgLoadResult): void {
  cached = result;
}
