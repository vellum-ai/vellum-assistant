import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/**
 * Shell commands that the `rtk` binary has a dedicated subcommand for.
 * Derived from `rtk --help` (rtk 0.36.0). Anything not in this set is
 * passed through unchanged.
 */
const RTK_SUBCOMMANDS = new Set([
  "ls",
  "tree",
  "read",
  "git",
  "gh",
  "aws",
  "psql",
  "pnpm",
  "test",
  "pytest",
  "vitest",
  "cargo",
  "npm",
  "npx",
  "tsc",
  "eslint",
  "lint",
  "grep",
  "find",
  "log",
  "diff",
  "docker",
  "kubectl",
  "wget",
  "wc",
  "prettier",
  "format",
  "playwright",
  "prisma",
  "next",
  "ruff",
  "mypy",
  "rake",
  "rubocop",
  "rspec",
  "pip",
  "curl",
]);

let cachedAvailable: boolean | null = null;
let testOverride: boolean | null = null;

function defaultIsRtkAvailable(): boolean {
  if (cachedAvailable !== null) return cachedAvailable;
  const pathEntries = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of pathEntries) {
    try {
      accessSync(join(dir, "rtk"), constants.X_OK);
      cachedAvailable = true;
      return true;
    } catch {
      // Not in this PATH entry — keep looking.
    }
  }
  cachedAvailable = false;
  return false;
}

function isRtkAvailable(): boolean {
  if (testOverride !== null) return testOverride;
  return defaultIsRtkAvailable();
}

/**
 * Test-only hook. Pass `true`/`false` to force the availability result,
 * or `null` to revert to the real check (and clear the cache).
 */
export function __setRtkAvailableForTest(value: boolean | null): void {
  testOverride = value;
  if (value === null) cachedAvailable = null;
}

/**
 * Find the byte offset in `command` where the head executable token
 * begins, after stripping `cd <path> &&`, env-var assignments, and
 * `sudo` prefixes in any order.
 */
function findHeadIndex(command: string): number {
  let i = 0;
  const n = command.length;
  while (i < n && /\s/.test(command[i]!)) i++;

  for (;;) {
    const rest = command.slice(i);

    const cd = /^cd\s+\S+\s*&&\s*/.exec(rest);
    if (cd) {
      i += cd[0].length;
      continue;
    }

    const env = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(rest);
    if (env) {
      i += env[0].length;
      continue;
    }

    const sudo = /^sudo\s+/.exec(rest);
    if (sudo) {
      i += sudo[0].length;
      continue;
    }

    return i >= n ? -1 : i;
  }
}

/**
 * Rewrite a shell command to delegate supported head commands to the
 * `rtk` binary (e.g. `git status` → `rtk git status`).
 *
 * Returns the command unchanged when:
 * - rtk is not on PATH
 * - the head executable isn't in {@link RTK_SUBCOMMANDS}
 * - the head can't be identified (empty command, only prefixes)
 *
 * Only the head segment of a pipeline is inspected; everything after
 * the first `|` stays verbatim. Prefixes like `cd X && `, env-var
 * assignments (`FOO=bar`), and `sudo` are preserved in place.
 */
export function rewriteForRtk(command: string): string {
  if (!command || !command.trim()) return command;
  if (!isRtkAvailable()) return command;

  // Pipes: only consider the head segment for classification. Insertion
  // still uses the original-command offset, so the tail is unchanged.
  const pipeIndex = command.indexOf("|");
  const headSegment = pipeIndex >= 0 ? command.slice(0, pipeIndex) : command;

  const headIdx = findHeadIndex(headSegment);
  if (headIdx < 0) return command;

  // Extract the first token — everything up to whitespace or a shell
  // metacharacter. This intentionally skips tokens that start with a
  // quote/backtick/variable so things like `"pytest"` or `$CMD` don't
  // get classified as rtk-eligible.
  const tokenMatch = /^([A-Za-z0-9_./-]+)/.exec(headSegment.slice(headIdx));
  if (!tokenMatch) return command;

  const token = tokenMatch[1]!;
  if (!RTK_SUBCOMMANDS.has(token)) return command;

  return command.slice(0, headIdx) + "rtk " + command.slice(headIdx);
}
