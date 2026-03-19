/**
 * Device ID resolver.
 *
 * Reads or creates a stable per-device UUID stored in device.json under the
 * Vellum config directory. The file is a JSON object (`{ "deviceId": "<uuid>" }`)
 * extensible for future per-device metadata.
 *
 * Path resolution:
 *   - Containerized (IS_CONTAINERIZED=true): uses BASE_DATA_DIR, which maps to a
 *     persistent volume. Each container is effectively its own "device."
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
 * In containerized environments, BASE_DATA_DIR points to a persistent volume
 * and homedir() is ephemeral, so we must use BASE_DATA_DIR.
 * In local environments (including multi-instance), homedir() is stable and
 * shared across instances, giving a true per-machine device ID.
 */
export function getDeviceIdBaseDir(): string {
  if (getIsContainerized()) {
    return getBaseDataDir() || homedir();
  }
  return homedir();
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
    log.warn({ err }, "Failed to read device.json — generating new device ID");
  }

  // Either the file doesn't exist, or deviceId was missing/empty.
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
