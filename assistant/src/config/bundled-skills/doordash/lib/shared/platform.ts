/**
 * Inlined platform utilities used by the DoorDash skill.
 * Subset of assistant/src/util/platform.ts — kept minimal.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function getRootDir(): string {
  const base = process.env.BASE_DATA_DIR?.trim();
  return join(base || homedir(), ".vellum");
}

export function getDataDir(): string {
  return join(getRootDir(), "workspace", "data");
}

export function getSocketPath(): string {
  const override = process.env.VELLUM_DAEMON_SOCKET?.trim();
  if (override) {
    if (override === "~") return homedir();
    if (override.startsWith("~/")) return join(homedir(), override.slice(2));
    return override;
  }
  return join(getRootDir(), "vellum.sock");
}

export function readSessionToken(): string | null {
  try {
    return readFileSync(join(getRootDir(), "session-token"), "utf-8").trim();
  } catch {
    return null;
  }
}
