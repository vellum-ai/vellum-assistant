/**
 * NUL-terminated `git status --porcelain -z` parsing.
 *
 * Status reporting and batched staging share this parser so rename/copy
 * origin paths cannot drift between the two readers.
 */

export interface PorcelainEntry {
  /** Two-character XY status from porcelain v1. */
  status: string;
  /** Path git reports for this record (the destination for rename/copy). */
  path: string;
  /** Pre-rename/copy path. Present when the record is a rename or copy. */
  origin?: string;
}

/**
 * Parse NUL-terminated `git status --porcelain -z` output into status/path
 * records. NUL termination is required so paths with special characters
 * (non-ASCII, quotes, newlines) arrive verbatim instead of C-style quoted.
 *
 * A rename/copy record is followed by a bare origin-path entry, captured on
 * {@link PorcelainEntry.origin}.
 */
export function parsePorcelainZ(stdout: string): PorcelainEntry[] {
  const entries = stdout.split("\0");
  const parsed: PorcelainEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    if (entry.length < 4) {
      continue;
    }
    const status = entry.substring(0, 2);
    const path = entry.substring(3);
    if (status[0] === "R" || status[0] === "C") {
      i++;
      const origin = entries[i];
      if (origin && origin.length > 0) {
        parsed.push({ status, path, origin });
        continue;
      }
    }
    parsed.push({ status, path });
  }
  return parsed;
}

/**
 * Every path git status knows about, including rename/copy origins.
 * Origins still need to be staged so a deletion is not left behind when a
 * rename is split across add batches.
 */
export function collectDirtyPathsFromPorcelain(stdout: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const entry of parsePorcelainZ(stdout)) {
    for (const path of [entry.path, entry.origin]) {
      if (!path || seen.has(path)) {
        continue;
      }
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}
