/**
 * Host device ID resolver.
 *
 * Mirrors the non-containerized branches of
 * `assistant/src/util/device-id.ts` so the CLI resolves the same
 * `device.json` as the assistant, host-mode gateway, and Swift client
 * (`VellumPaths.deviceIdFile`):
 *   - Production: `~/.vellum/device.json` (legacy path — intentionally NOT
 *     the CLI's `getConfigDir()` location of `~/.config/vellum/`).
 *   - Non-production: `$XDG_CONFIG_HOME/vellum-<env>/device.json`.
 *
 * Not to be confused with `guardian-token.ts:computeDeviceId` /
 * `getOrCreatePersistedDeviceId` — those produce the salted-hash Guardian
 * identity, a different concept. Do not merge the two.
 */

import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { getConfigDir } from "./environments/paths.js";
import { getCurrentEnvironment } from "./environments/resolve.js";

let cached: string | undefined;

function resolveDeviceIdPaths(): { dir: string; file: string } {
  const env = getCurrentEnvironment();
  const dir =
    env.name === "production"
      ? join(homedir(), ".vellum")
      : getConfigDir(env);
  return { dir, file: join(dir, "device.json") };
}

/**
 * Get the stable device ID for this host machine, creating and persisting
 * one in `device.json` if absent. Never throws: on write failure the
 * generated UUID is still cached and returned for the process lifetime.
 */
export function getOrCreateHostDeviceId(): string {
  if (cached !== undefined) {
    return cached;
  }

  const { dir, file } = resolveDeviceIdPaths();

  // Preserve unrelated fields from any existing JSON object.
  let existing: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      existing = raw as Record<string, unknown>;
    }
  } catch {
    // Missing, unreadable, or malformed — start fresh.
  }

  if (typeof existing.deviceId === "string" && existing.deviceId.length > 0) {
    cached = existing.deviceId;
    return cached;
  }

  const generated = randomUUID();
  try {
    mkdirSync(dir, { recursive: true });
    existing.deviceId = generated;
    writeFileSync(file, JSON.stringify(existing, null, 2) + "\n", {
      mode: 0o644,
    });
  } catch {
    // Write failure — use the generated ID in-memory only.
  }

  cached = generated;
  return cached;
}

/** Reset the cached device ID. Used by tests to force re-resolution. */
export function resetHostDeviceIdCache(): void {
  cached = undefined;
}
