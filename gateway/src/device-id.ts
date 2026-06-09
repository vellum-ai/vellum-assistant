import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getLegacyRootDir } from "./paths.js";

let cached: string | null = null;

export function getDeviceId(): string | null {
  if (cached !== null) return cached;
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
