import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/**
 * Shell commands that the `rtk` binary has a dedicated subcommand for.
 * Derived from `rtk --help` (rtk 0.36.0). Anything not in this set is
 * passed through unchanged.
 *
 * Deliberately excluded even though `rtk` has a matching subcommand:
 * - `test`, `read` — bash builtins. `test -f foo` or `read var` would
 *   mis-dispatch to rtk's test-runner / file-reader subcommand and
 *   misinterpret the flags.
 */
const RTK_SUBCOMMANDS = new Set([
  "ls",
  "tree",
  "git",
  "gh",
  "aws",
  "psql",
  "pnpm",
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

// Positive-only cache keyed by the PATH that was probed. Different
// callers can use different PATHs (e.g. `host_bash` prepends
// `~/.bun/bin` via buildHostShellEnv), so caching a single global
// answer is wrong. A negative result is never cached — installing rtk
// mid-session (or a PATH update) should start working without a
// restart.
let cachedPositive: { path: string } | null = null;
let testOverride: boolean | null = null;

function defaultIsRtkAvailable(pathEnv: string): boolean {
  if (cachedPositive && cachedPositive.path === pathEnv) return true;
  const pathEntries = pathEnv.split(":").filter(Boolean);
  for (const dir of pathEntries) {
    try {
      accessSync(join(dir, "rtk"), constants.X_OK);
      cachedPositive = { path: pathEnv };
      return true;
    } catch {
      // Not in this PATH entry — keep looking.
    }
  }
  return false;
}

function isRtkAvailable(pathEnv: string): boolean {
  if (testOverride !== null) return testOverride;
  return defaultIsRtkAvailable(pathEnv);
}

/**
 * Test-only hook. Pass `true`/`false` to force the availability result,
 * or `null` to revert to the real check (and clear the positive cache).
 */
export function __setRtkAvailableForTest(value: boolean | null): void {
  testOverride = value;
  if (value === null) cachedPositive = null;
}

/**
 * Find the offset of the first `|` in `s` that is not inside a
 * single- or double-quoted string. Returns -1 if none.
 *
 * Quote-aware so commands like `git log --grep="a|b" | less` split on
 * the outer pipe instead of the one inside the quoted argument.
 */
function findUnquotedPipe(s: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      i++;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (c === "|" && !inSingle && !inDouble) return i;
  }
  return -1;
}

/**
 * Find the byte offset in `command` where the head executable token
 * begins, after stripping `cd <path> &&`, env-var assignments, and
 * `sudo` prefixes in any order. The `cd` form accepts a quoted path
 * (single or double) so paths with spaces still strip cleanly.
 */
function findHeadIndex(command: string): number {
  let i = 0;
  const n = command.length;
  while (i < n && /\s/.test(command[i]!)) i++;

  for (;;) {
    const rest = command.slice(i);

    const cd = /^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/.exec(rest);
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
 * `pathEnv` must be the PATH the subprocess will actually execute with
 * (not `process.env.PATH`, which on macOS app-launched daemons is
 * minimal — `buildHostShellEnv` prepends `~/.bun/bin`, etc.). The rtk
 * probe walks that PATH directly.
 *
 * Returns the command unchanged when:
 * - rtk is not on the subprocess PATH
 * - the caller overrides `PATH` in the command's env-var prefix, or
 *   the command is run through `sudo` (both execute with a PATH we
 *   can't probe from the daemon — rtk may be missing there)
 * - the head executable isn't in {@link RTK_SUBCOMMANDS}
 * - the head can't be identified (empty command, only prefixes)
 *
 * Only the head segment of a pipeline is inspected; everything after
 * the first `|` stays verbatim. Prefixes like `cd X && ` and env-var
 * assignments (`FOO=bar`) are preserved in place.
 */
export function rewriteForRtk(command: string, pathEnv: string): string {
  if (!command || !command.trim()) return command;
  if (!isRtkAvailable(pathEnv)) return command;

  // Pipes: only consider the head segment for classification. Use
  // quote-aware detection so a `|` inside a quoted argument doesn't
  // truncate the classifier's view of the head command. Insertion
  // still uses the original-command offset, so the tail is unchanged.
  const pipeIndex = findUnquotedPipe(command);
  const headSegment = pipeIndex >= 0 ? command.slice(0, pipeIndex) : command;

  const headIdx = findHeadIndex(headSegment);
  if (headIdx < 0) return command;

  // PATH-visibility guard: if the caller scopes `PATH=` to the command
  // (e.g. `PATH=/usr/bin git status`) or runs under `sudo` (which uses
  // its own `secure_path` that typically omits user-level bins like
  // ~/.bun/bin or /opt/homebrew/bin), the daemon's rtk probe doesn't
  // reflect what the subprocess will see. Injecting `rtk` there could
  // turn a working command into `rtk: command not found`. Bail out.
  const prefixBeforeHead = headSegment.slice(0, headIdx);
  if (/(?:^|\s)PATH\s*=/.test(prefixBeforeHead)) return command;
  if (/(?:^|\s)sudo(?:\s|$)/.test(prefixBeforeHead)) return command;

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
