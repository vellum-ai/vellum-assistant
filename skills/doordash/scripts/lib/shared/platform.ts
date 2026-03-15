/**
 * Inlined platform utilities used by the DoorDash skill.
 * Subset of assistant/src/util/platform.ts — kept minimal.
 */

import { homedir } from "node:os";
import { join } from "node:path";

function getRootDir(): string {
  const base = process.env.BASE_DATA_DIR?.trim();
  return join(base || homedir(), ".vellum");
}

export function getDataDir(): string {
  return join(getRootDir(), "workspace", "data");
}
