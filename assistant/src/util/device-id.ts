/**
 * Device ID resolver.
 *
 * Reads or creates a stable per-device UUID stored in device.json under the
 * Vellum config directory. The file is a JSON object (`{ "deviceId": "<uuid>" }`)
 * extensible for future per-device metadata.
 *
 * Path resolution:
 *   - Containerized (IS_CONTAINERIZED=true): uses /home/assistant (the assistant
 *     user's persistent home dir) so device.json lives on the assistant's own
 *     filesystem rather than the shared data volume. Falls back to BASE_DATA_DIR
 *     for migration from the old location.
 *   - Local (single or multi-instance): uses homedir() so all instances on the
 *     same machine share a single device ID, even when BASE_DATA_DIR is set to
 *     an instance-scoped directory.
 *
 * The value is cached in memory after the first successful read/write.
 * Falls back to a generated UUID if the file cannot be read or written.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getBaseDataDir, getIsContainerized } from "../config/env-registry.js";
import { getLogger } from "./logger.js";

const log = getLogger("device-id");

let cached: string | undefined;

/**
 * Resolve the base directory for device.json.
 *
 * In containerized environments, device.json is stored under /home/assistant
 * (the assistant user's persistent home dir) rather than on the shared data
 * volume. Device ID is assistant-specific state that doesn't need to be shared.
 * In local environments (including multi-instance), homedir() is stable and
 * shared across instances, giving a true per-machine device ID.
 */
export function getDeviceIdBaseDir(): string {
  if (getIsContainerized()) {
    return "/home/assistant";
  }
  return homedir();
}

/**
 * Resolve the legacy base directory for device.json migration.
 *
 * Returns the old containerized path (BASE_DATA_DIR) so we can fall back to
 * reading device.json from the shared volume if it hasn't been migrated yet.
 * Returns undefined when not containerized or when no legacy path exists.
 */
function getLegacyDeviceIdBaseDir(): string | undefined {
  if (!getIsContainerized()) {
    return undefined;
  }
  const baseDataDir = getBaseDataDir();
  return baseDataDir || undefined;
}

/**
 * Get the stable device ID for this machine.
 *
 * Resolution order:
 *   1. Cached in-memory value (populated on first call)
 *   2. `deviceId` field from device.json
 *   3. Generate a new UUID, persist it to device.json, and return it
 *
 * On any read/write error the generated UUID is still cached so the
 * process uses a consistent ID for the remainder of its lifetime.
 */
export function getDeviceId(): string {
  if (cached !== undefined) {
    return cached;
  }

  const vellumDir = join(getDeviceIdBaseDir(), ".vellum");
  const filePath = join(vellumDir, "device.json");
  const generated = randomUUID();

  try {
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      if (
        raw &&
        typeof raw === "object" &&
        typeof raw.deviceId === "string" &&
        raw.deviceId.length > 0
      ) {
        cached = raw.deviceId as string;
        log.info({ deviceId: cached }, "Resolved device ID from device.json");
        return cached;
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to read device.json — checking legacy path");
  }

  // Migration fallback: check the legacy location (shared volume) if the new
  // location doesn't have a valid device.json yet.
  const legacyBase = getLegacyDeviceIdBaseDir();
  if (legacyBase) {
    const legacyPath = join(legacyBase, ".vellum", "device.json");
    try {
      if (existsSync(legacyPath)) {
        const raw = JSON.parse(readFileSync(legacyPath, "utf-8"));
        if (
          raw &&
          typeof raw === "object" &&
          typeof raw.deviceId === "string" &&
          raw.deviceId.length > 0
        ) {
          cached = raw.deviceId as string;
          log.info(
            { deviceId: cached },
            "Resolved device ID from legacy device.json — will persist to new location",
          );
          // Persist to the new location so future reads don't need the fallback
          try {
            mkdirSync(vellumDir, { recursive: true });
            writeFileSync(
              filePath,
              JSON.stringify({ deviceId: cached }, null, 2) + "\n",
              { mode: 0o644 },
            );
            log.info("Migrated device.json to new location");
          } catch (writeErr) {
            log.warn(
              { err: writeErr },
              "Failed to migrate device.json to new location",
            );
          }
          return cached;
        }
      }
    } catch (err) {
      log.warn(
        { err },
        "Failed to read legacy device.json — generating new device ID",
      );
    }
  }

  // Either the file doesn't exist at either location, or deviceId was missing/empty.
  // Generate a new UUID and persist it.
  try {
    mkdirSync(vellumDir, { recursive: true });

    // Read existing content to preserve other fields
    let existing: Record<string, unknown> = {};
    try {
      if (existsSync(filePath)) {
        const raw = JSON.parse(readFileSync(filePath, "utf-8"));
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          existing = raw as Record<string, unknown>;
        }
      }
    } catch {
      // Malformed JSON — start fresh
    }

    existing.deviceId = generated;
    writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n", {
      mode: 0o644,
    });
    log.info({ deviceId: generated }, "Created new device ID in device.json");
  } catch (err) {
    log.warn(
      { err },
      "Failed to write device.json — using generated device ID in-memory only",
    );
  }

  cached = generated;
  return cached;
}

/**
 * Reset the cached device ID. Used by tests to force
 * re-resolution on the next call.
 */
export function resetDeviceIdCache(): void {
  cached = undefined;
}
