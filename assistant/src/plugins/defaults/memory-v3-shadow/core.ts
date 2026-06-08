import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { LeafPath } from "./types.js";

/**
 * Loads the always-on core leaf set from `<dataDir>/core.json`.
 *
 * The caller is responsible for resolving `dataDir` (including any
 * workspace-local override — see `resolveDataDir` in `tree.ts`). A missing
 * `core.json` yields an empty set (new workspaces may have no curated core).
 */
export async function loadCore(dataDir: string): Promise<Set<LeafPath>> {
  const path = join(dataDir, "core.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as { alwaysOn?: LeafPath[] };
  return new Set(parsed.alwaysOn ?? []);
}
