/**
 * Resolution of the PKB auto-inject file list (`pkb/_autoinject.md`).
 *
 * Which PKB files are always loaded into context is a PKB-domain concern
 * owned here next to {@link getPkbRoot}, so both the runtime injector and the
 * reminder-hint tracker resolve the list from a single canonical source
 * rather than threading it through the orchestrator.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stripCommentLines } from "../host-utils.js";

const PKB_DEFAULT_FILES = [
  "INDEX.md",
  "essentials.md",
  "threads.md",
  "buffer.md",
];

const AUTOINJECT_FILENAME = "_autoinject.md";

/**
 * Read `_autoinject.md` from the PKB directory and return the list of
 * filenames to inject.
 *
 * - Returns `null` when the file is missing or unreadable — callers
 *   should fall back to the hardcoded defaults.
 * - Returns `[]` when the file exists but has no entries (empty or
 *   comments only) — an explicit opt-out meaning "inject nothing."
 */
export function readAutoinjectList(pkbDir: string): string[] | null {
  const filePath = join(pkbDir, AUTOINJECT_FILENAME);
  if (!existsSync(filePath)) return null;
  try {
    const raw = stripCommentLines(readFileSync(filePath, "utf-8"));
    const files = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return files.length > 0 ? files : [];
  } catch {
    return null;
  }
}

/**
 * Resolve the effective list of auto-inject filenames for a PKB directory.
 *
 * This is the single source of truth used both by `readPkbContext` (which
 * actually injects the files) and by the PKB reminder-hint injector (which
 * needs to know what's already in context so it doesn't redundantly
 * recommend those files).
 *
 * Returns `PKB_DEFAULT_FILES` when `_autoinject.md` is missing/unreadable,
 * or the parsed list (possibly empty) when it is present.
 */
export function getPkbAutoInjectList(pkbRoot: string): string[] {
  return readAutoinjectList(pkbRoot) ?? PKB_DEFAULT_FILES;
}
