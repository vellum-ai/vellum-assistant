/**
 * Host device ID resolver.
 *
 * Resolution order (mirrors `gateway/src/device-id.ts`):
 *   1. `VELLUM_DEVICE_ID` env var, if set — lets the desktop app hand the
 *      canonical device id down to the CLI.
 *   2. `device.json` in the CLI-owned config dir (`getConfigDir()`):
 *      production → `~/.config/vellum/device.json`, non-production →
 *      `$XDG_CONFIG_HOME/vellum-<env>/device.json`. Per cli/AGENTS.md, the
 *      CLI must never touch `~/.vellum/` — that is assistant/gateway-owned
 *      state.
 *
 * Accepted tradeoff: this intentionally does NOT read the legacy
 * `~/.vellum/device.json`, so a containerized gateway's device id may differ
 * from a host-mode gateway's on the same machine. Stability matters for LD
 * feature-flag contexts, not parity with the legacy file.
 *
 * Not to be confused with `guardian-token.ts:computeDeviceId` /
 * `getOrCreatePersistedDeviceId` — those produce the salted-hash Guardian
 * identity, a different concept. Do not merge the two.
 */

import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { getConfigDir } from "./environments/paths.js";
import { getCurrentEnvironment } from "./environments/resolve.js";

let cached: string | undefined;

function resolveDeviceIdPaths(): { dir: string; file: string } {
  const dir = getConfigDir(getCurrentEnvironment());
  return { dir, file: join(dir, "device.json") };
}

/**
 * Get the stable device ID for this host machine, creating and persisting
 * one in `device.json` if absent. `VELLUM_DEVICE_ID` takes precedence over
 * any file. Never throws: on write failure the generated UUID is still
 * cached and returned for the process lifetime.
 */
export function getOrCreateHostDeviceId(): string {
  if (cached !== undefined) {
    return cached;
  }

  const fromEnv = process.env.VELLUM_DEVICE_ID?.trim();
  if (fromEnv) {
    cached = fromEnv;
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
