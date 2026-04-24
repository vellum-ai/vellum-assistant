import { existsSync } from "node:fs";
import { dirname, sep } from "node:path";

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "Makefile",
] as const;

/**
 * Walk upward from `startDir` looking for a directory containing any
 * PROJECT_MARKERS entry. Returns the first match, or undefined if the
 * walk reaches the filesystem root with no marker found.
 *
 * Stops at `stopAt` (inclusive) when provided — useful in tests and to
 * bound the walk to a known workspace root.
 */
export function findProjectBoundary(
  startDir: string,
  stopAt?: string,
): string | undefined {
  let current = startDir;
  let previous = "";
  while (current !== previous) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(`${current}${sep}${marker}`)) {
        return current;
      }
    }
    if (stopAt && current === stopAt) return undefined;
    previous = current;
    current = dirname(current);
  }
  return undefined;
}
