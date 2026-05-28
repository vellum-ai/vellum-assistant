import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getWorkspaceDir } from "../../util/platform.js";
import { LeafPath } from "./types.js";

/**
 * Resolves the directory to load `core.json` from, preferring a
 * workspace-local override at `<workspace>/memory/v3/data` when present.
 * Falls back to the supplied bundled `dataDir`.
 *
 * Kept local (rather than imported from tree.ts) to avoid coupling between
 * v3 modules.
 */
export function resolveDataDir(bundledDir: string): string {
  const workspaceDir = join(getWorkspaceDir(), "memory", "v3", "data");
  if (existsSync(join(workspaceDir, "core.json"))) return workspaceDir;
  return bundledDir;
}

/**
 * Loads the always-on core leaf set from `<dataDir>/core.json`.
 *
 * Prefers a workspace-local override when present. A missing `core.json`
 * yields an empty set (new workspaces may have no curated core).
 */
export async function loadCore(dataDir: string): Promise<Set<LeafPath>> {
  const path = join(resolveDataDir(dataDir), "core.json");
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
