import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getLegacyRootDir } from "./paths.js";

let cached: string | null = null;

/**
 * Read the persistent device ID from device.json or the VELLUM_DEVICE_ID
 * env var. In containerized deployments, the gateway sidecar cannot access
 * the assistant's home directory — the orchestration layer can set
 * VELLUM_DEVICE_ID to thread the value through instead.
 */
export function getDeviceId(): string | null {
  if (cached !== null) return cached;

  const envDeviceId = process.env.VELLUM_DEVICE_ID?.trim();
  if (envDeviceId) {
    cached = envDeviceId;
    return cached;
  }

  try {
    const raw = readFileSync(join(getLegacyRootDir(), "device.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.deviceId === "string" && parsed.deviceId) {
      cached = parsed.deviceId;
      return cached;
    }
  } catch {}
  return null;
}
