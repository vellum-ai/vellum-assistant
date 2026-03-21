/**
 * Gateway-side feature flag store — file-backed persistence of feature flag
 * override values.
 *
 * Mirrors the trust-store.ts pattern: file path resolution via
 * GATEWAY_SECURITY_DIR (Docker) or ~/.vellum/protected/ (local), atomic
 * writes (temp file + rename), 0o600 permissions, and module-level caching
 * with manual invalidation.
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

const log = getLogger("feature-flag-store");

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

export function getFeatureFlagStorePath(): string {
  const securityDir = process.env.GATEWAY_SECURITY_DIR;
  if (securityDir) {
    return join(securityDir, "feature-flags.json");
  }
  return join(getRootDir(), "protected", "feature-flags.json");
}

// ---------------------------------------------------------------------------
// Disk I/O with caching
// ---------------------------------------------------------------------------

let cachedValues: Record<string, boolean> | null = null;

export function readPersistedFeatureFlags(): Record<string, boolean> {
  if (cachedValues != null) return cachedValues;

  const path = getFeatureFlagStorePath();
  if (!existsSync(path)) {
    cachedValues = {};
    return cachedValues;
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as FeatureFlagFileData;

    if (data.version !== 1) {
      log.warn(
        { version: data.version },
        "Unknown feature flag store version, returning empty values",
      );
      cachedValues = {};
      return cachedValues;
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
      cachedValues = filtered;
    } else {
      cachedValues = {};
    }
    return cachedValues;
  } catch (err) {
    log.error({ err }, "Failed to load feature flag store");
    cachedValues = {};
    return cachedValues;
  }
}

export function writeFeatureFlag(key: string, enabled: boolean): void {
  // Re-read from disk to avoid lost updates
  cachedValues = null;
  const values = { ...readPersistedFeatureFlags() };
  values[key] = enabled;

  const path = getFeatureFlagStorePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const data: FeatureFlagFileData = { version: 1, values };
  const tmpPath = path + ".tmp." + process.pid;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);

  cachedValues = values;
  log.info({ key, enabled }, "Wrote feature flag");
}

export function clearFeatureFlagStoreCache(): void {
  cachedValues = null;
}
