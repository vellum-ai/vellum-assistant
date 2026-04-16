/**
 * Device ID resolver.
 *
 * Reads or creates a stable per-device UUID stored in device.json under the
 * Vellum config directory. The file is a JSON object (`{ "deviceId": "<uuid>" }`)
 * extensible for future per-device metadata.
 *
 * Path resolution:
 *   - Containerized (IS_CONTAINERIZED=true): `/home/assistant/.vellum/device.json`
 *     — the assistant user's persistent home dir, kept off the shared data
 *     volume. Not affected by VELLUM_ENVIRONMENT because the container fs
 *     has no cross-process contract with the Swift client.
 *   - Non-containerized production: `~/.vellum/device.json` (legacy, shared
 *     across all local instances on the same machine).
 *   - Non-containerized non-production: `$XDG_CONFIG_HOME/vellum-<env>/device.json`,
 *     matching Swift's `VellumPaths.deviceIdFile`.
 *
 * The value is cached in memory after the first successful read/write.
 * Falls back to a generated UUID if the file cannot be read or written.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { getLogger } from "./logger.js";
import { getXdgVellumConfigDirName } from "./platform.js";

const log = getLogger("device-id");

let cached: string | undefined;

/**
 * Resolve the directory and file path for `device.json` based on the
 * runtime environment. See the module docblock for the resolution table.
 *
 * Production and containerized modes preserve the legacy `~/.vellum` /
 * `/home/assistant/.vellum` paths. Non-production, non-containerized
 * deployments route through `$XDG_CONFIG_HOME/vellum-<env>` to match
 * the Swift client's `VellumPaths.deviceIdFile`.
 */
function resolveDeviceIdPaths(): { dir: string; file: string } {
  if (getIsContainerized()) {
    const dir = join("/home/assistant", ".vellum");
    return { dir, file: join(dir, "device.json") };
  }

  const configDirName = getXdgVellumConfigDirName();
  if (configDirName === "vellum") {
    // Production: device.json lives at ~/.vellum/device.json, shared
    // across all local instances on the same machine.
    const dir = join(homedir(), ".vellum");
    return { dir, file: join(dir, "device.json") };
  }

  const configHome =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  const dir = join(configHome, configDirName);
  return { dir, file: join(dir, "device.json") };
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

  const { dir: vellumDir, file: filePath } = resolveDeviceIdPaths();
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

  // Either the file doesn't exist or deviceId was missing/empty.
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
