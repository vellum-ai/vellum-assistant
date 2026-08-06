import { lstatSync, readlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Follow a trailing symlink chain manually so a DANGLING link reports its
 * destination. `realpathSync` throws on a link whose destination does not
 * exist, which makes canonicalization fall back to the benign link path —
 * but a write through the link creates the destination, so containment and
 * security checks must see it. The bound sits above every supported
 * platform's own traversal limit (Linux follows at most 40 links per
 * resolution, macOS 32), so any chain this loop cannot exhaust is one the
 * filesystem itself refuses to follow (ELOOP) — the eventual operation
 * fails rather than writing through an unchecked destination.
 */
export function resolveTrailingLinkTarget(path: string): string {
  let current = path;
  for (let depth = 0; depth < 64; depth++) {
    let linkTarget: string;
    try {
      if (!lstatSync(current).isSymbolicLink()) {
        return current;
      }
      linkTarget = readlinkSync(current);
    } catch {
      return current;
    }
    current = resolve(dirname(current), linkTarget);
  }
  return current;
}
