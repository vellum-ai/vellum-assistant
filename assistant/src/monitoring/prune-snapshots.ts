import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Keep only the newest `max` `<prefix><timestamp>.json` files in `dir`.
 * Filenames embed a millisecond timestamp, so lexical sort is chronological.
 * Best-effort: unreadable dirs and failed deletes are ignored.
 */
export function prunePrefixedJsonFiles(
  dir: string,
  prefix: string,
  max: number,
): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (f) => f.startsWith(prefix) && f.endsWith(".json"),
    );
  } catch {
    return;
  }
  if (files.length <= max) {
    return;
  }
  files.sort();
  for (const stale of files.slice(0, files.length - max)) {
    try {
      rmSync(join(dir, stale));
    } catch {
      // best-effort
    }
  }
}
