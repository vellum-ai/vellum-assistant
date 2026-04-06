/**
 * Gateway-side remote feature flag store — file-backed persistence of
 * feature flag values pushed from the platform.
 *
 * Mirrors the feature-flag-store.ts pattern: file path resolution via
 * GATEWAY_SECURITY_DIR (Docker) or ~/.vellum/protected/ (local), atomic
 * writes (temp file + rename), 0o600 permissions, and module-level caching
 * with manual invalidation.
 *
 * Unlike the local override store, writes replace the *entire* value map at
 * once (the platform pushes a complete snapshot) and immediately update the
 * in-memory cache so no file watcher is needed.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "./logger.js";
import { getRootDir } from "./credential-reader.js";

const log = getLogger("feature-flag-remote-store");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FeatureFlagFileData {
  version: 1;
  values: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// File path
// ---------------------------------------------------------------------------

export function getRemoteFeatureFlagStorePath(): string {
  const securityDir = process.env.GATEWAY_SECURITY_DIR;
  if (securityDir) {
    return join(securityDir, "feature-flags-remote.json");
  }
  return join(getRootDir(), "protected", "feature-flags-remote.json");
}

// ---------------------------------------------------------------------------
// Disk I/O with caching
// ---------------------------------------------------------------------------

/**
 * Read remote feature flag values.
 *
 * Unlike the local override store, remote values are **always read fresh
 * from disk** — the file is small and reads only happen on API calls.
 * This avoids stale-cache bugs where the file is updated on disk (by the
 * periodic sync or another process) but the in-memory cache still holds
 * an old snapshot.
 */
export function readRemoteFeatureFlags(): Record<string, boolean> {
  const path = getRemoteFeatureFlagStorePath();
  if (!existsSync(path)) {
    return {};
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as FeatureFlagFileData;

    if (data.version !== 1) {
      log.warn(
        { version: data.version },
        "Unknown remote feature flag store version, returning empty values",
      );
      return {};
    }

    if (
      data.values &&
      typeof data.values === "object" &&
      !Array.isArray(data.values)
    ) {
      const filtered: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(data.values)) {
        if (typeof v === "boolean") filtered[k] = v;
      }
      return filtered;
    } else {
      return {};
    }
  } catch (err) {
    log.error({ err }, "Failed to load remote feature flag store");
    return {};
  }
}

export function writeRemoteFeatureFlags(values: Record<string, boolean>): void {
  const path = getRemoteFeatureFlagStorePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const data: FeatureFlagFileData = { version: 1, values };
  const tmpPath = path + ".tmp." + process.pid;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);

  log.info({ count: Object.keys(values).length }, "Wrote remote feature flags");
}

/**
 * No-op — retained for API compatibility.
 *
 * The remote store no longer caches reads (always reads fresh from disk),
 * so there is nothing to clear. Callers (tests, watcher) can still call
 * this without harm.
 */
export function clearRemoteFeatureFlagStoreCache(): void {
  // intentional no-op
}
