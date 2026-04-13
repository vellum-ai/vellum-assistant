/**
 * Gateway-side remote feature flag store — file-backed persistence of
 * feature flag values pushed from the platform.
 *
 * Mirrors the feature-flag-store.ts pattern: file path resolution via
 * getGatewaySecurityDir(), atomic writes (temp file + rename), 0o600
 * permissions, and module-level caching with manual invalidation.
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
import { getGatewaySecurityDir } from "./paths.js";

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
  return join(getGatewaySecurityDir(), "feature-flags-remote.json");
}

// ---------------------------------------------------------------------------
// Disk I/O with caching
// ---------------------------------------------------------------------------

let cachedRemoteValues: Record<string, boolean> | null = null;

export function readRemoteFeatureFlags(): Record<string, boolean> {
  if (cachedRemoteValues != null) return cachedRemoteValues;

  const path = getRemoteFeatureFlagStorePath();
  if (!existsSync(path)) {
    cachedRemoteValues = {};
    return cachedRemoteValues;
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as FeatureFlagFileData;

    if (data.version !== 1) {
      log.warn(
        { version: data.version },
        "Unknown remote feature flag store version, returning empty values",
      );
      cachedRemoteValues = {};
      return cachedRemoteValues;
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
      cachedRemoteValues = filtered;
    } else {
      cachedRemoteValues = {};
    }
    return cachedRemoteValues;
  } catch (err) {
    log.error({ err }, "Failed to load remote feature flag store");
    cachedRemoteValues = {};
    return cachedRemoteValues;
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

  cachedRemoteValues = values;
  log.info({ count: Object.keys(values).length }, "Wrote remote feature flags");
}

/**
 * Clear the in-memory cache so the next `readRemoteFeatureFlags()` call
 * re-reads from disk. Useful in tests for resetting state between cases.
 */
export function clearRemoteFeatureFlagStoreCache(): void {
  cachedRemoteValues = null;
}

/**
 * Re-read the remote feature flag file from disk into the in-memory cache.
 *
 * Called by the file watcher when `feature-flags-remote.json` changes on
 * disk (e.g. written by a separate process or a previous gateway instance).
 * This ensures the next `readRemoteFeatureFlags()` call returns fresh data
 * without requiring every read to hit disk.
 */
export function refreshRemoteFeatureFlagStoreCache(): void {
  cachedRemoteValues = null;
  // Force a re-read into cache immediately so the next
  // readRemoteFeatureFlags() call picks up the new values.
  readRemoteFeatureFlags();
}
