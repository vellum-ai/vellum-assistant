/**
 * Read-only shell gate — enforces a real command allowlist when a subagent
 * (or any tool context) is running in `shellMode: "read-only"`.
 *
 * The investigator subagent role advertises read-only investigation, but
 * without an enforcement layer the preamble is just prompt text. This module
 * validates commands before they reach `spawn("bash", ["-c", "--", cmd])`,
 * blocking filesystem writes, process side effects, and shell-level bypasses.
 *
 * Strategy:
 *  1. Reject shell metacharacters that can chain or substitute arbitrary
 *     commands: `;`, `&&`, `||`, backticks, `$(`, `>`, `>>`, `<`.
 *  2. Allow `|` (pipe) but validate every piped command's base binary.
 *  3. Extract the base binary from each command segment and check it against
 *     an allowlist of read-only investigation tools.
 *
 * This is defense-in-depth, not a sandbox. A sufficiently sophisticated
 * payload could still find gaps. But it raises the bar from "zero enforcement"
 * to "blocks accidental damage and common injection patterns" — which is the
 * gap ATL-864 identified.
 */

/**
 * Commands permitted in read-only shell mode.
 *
 * Categories:
 *  - Search: grep, rg, ag, ack, find, locate
 *  - Read: cat, head, tail, less, more, wc, file, stat, strings, xxd, od,
 *    cut, tr, sort, uniq, column, paste, expand, unexpand, fold, fmt, nl,
 *    pr, tac, rev, comm, fold
 *  - List: ls, dir, tree, du, df
 *  - Git (read-only subcommands validated separately): git
 *  - Process/system: ps, lsof, netstat, ss, env, printenv, uname, hostname,
 *    uptime, date, whoami, id, pwd, echo, which, type, command, printf,
 *    test, true, false
 *  - Diff: diff, cmp
 *  - Misc read-only: readlink, realpath, basename, dirname, seq, yes (piped
 *    into grep etc.), md5sum, sha256sum, cksum, b2sum
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  // Search
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "find",
  "locate",
  // Read
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "file",
  "stat",
  "strings",
  "xxd",
  "od",
  "cut",
  "tr",
  "sort",
  "uniq",
  "column",
  "paste",
  "expand",
  "unexpand",
  "fold",
  "fmt",
  "nl",
  "pr",
  "tac",
  "rev",
  "comm",
  // List
  "ls",
  "dir",
  "tree",
  "du",
  "df",
  // Git (subcommand validated separately)
  "git",
  // Process / system info
  "ps",
  "lsof",
  "netstat",
  "ss",
  "env",
  "printenv",
  "uname",
  "hostname",
  "uptime",
  "date",
  "whoami",
  "id",
  "pwd",
  "echo",
  "printf",
  "which",
  "type",
  "command",
  "test",
  "true",
  "false",
  // Diff
  "diff",
  "cmp",
  // Path utilities
  "readlink",
  "realpath",
  "basename",
  "dirname",
  // Sequence / hashing
  "seq",
  "md5sum",
  "sha256sum",
  "cksum",
  "b2sum",
  // Misc
  "awk",
  "sed",
]);

/**
 * Git subcommands that are read-only. Any git subcommand not in this set is
 * rejected in read-only mode.
 */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "log",
  "show",
  "diff",
  "blame",
  "status",
  "branch",
  "tag",
  "remote",
  "ls-files",
  "rev-parse",
  "grep",
  "describe",
  "shortlog",
  "name-rev",
  "ls-tree",
  "cat-file",
  "reflog",
  "config",
  "stash",
]);

/**
 * Shell metacharacters that can chain to arbitrary commands or redirect
 * output. If any of these appear in the command (outside of quotes), the
 * command is rejected.
 *
 * We check for the raw patterns — false positives from quoted strings
 * (e.g. `grep "foo; bar"`) are an acceptable tradeoff. The investigator can
 * use single quotes or escape differently if needed, and the common
 * investigation commands (grep, find, cat) don't typically need these
 * metacharacters in their arguments.
 */
const BLOCKED_METACHARACTER_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  reason: string;
}> = [
  { pattern: /;/, reason: "command chaining with ';'" },
  { pattern: /&&/, reason: "command chaining with '&&'" },
  { pattern: /\|\|/, reason: "command chaining with '||'" },
  { pattern: /`/, reason: "backtick command substitution" },
  { pattern: /\$\(/, reason: "'$()' command substitution" },
  { pattern: />>?/, reason: "output redirection" },
  { pattern: /<[^\(]/, reason: "input redirection" },
];

export interface ReadOnlyShellValidationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Extract the base binary name from a command segment.
 *
 * Strips leading whitespace, environment variable assignments (`VAR=value cmd`),
 * and leading `command`/`exec` prefixes. Returns the first non-flag token
 * as the binary name, or null if none is found.
 */
function extractBaseBinary(segment: string): string | null {
  let trimmed = segment.trimStart();

  // Strip leading env var assignments: FOO=bar BAZ=qux cmd -> cmd
  // These are `WORD=WORD` patterns before the actual command.
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
    // Remove the assignment token
    trimmed = trimmed.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }

  if (!trimmed) return null;

  // Tokenize: first whitespace-delimited token is the binary.
  // But skip leading `command`, `exec`, `builtin` prefixes.
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0] ?? "";

  // Strip path prefix — we check by basename, not full path.
  // `foo` could be `/usr/bin/grep` or `./malicious_script`.
  // We only allow bare command names (no path separators) to prevent
  // executing arbitrary scripts by path.
  if (first.includes("/")) return null;

  // Strip `command`/`exec`/`builtin` prefixes and re-check.
  if (first === "command" || first === "exec" || first === "builtin") {
    const next = tokens[1] ?? "";
    if (!next || next.startsWith("-")) return null;
    if (next.includes("/")) return null;
    return next;
  }

  return first || null;
}

/**
 * Validate a single command segment (no pipes) against the read-only allowlist.
 */
function validateSegment(segment: string): ReadOnlyShellValidationResult {
  const binary = extractBaseBinary(segment);
  if (!binary) {
    return { allowed: false, reason: "could not extract base command" };
  }

  // `sed` is allowed only without `-i` (in-place edit).
  if (binary === "sed") {
    if (/\s-i\b/.test(segment) || /\s-i\s*$/.test(segment)) {
      return {
        allowed: false,
        reason: "sed -i (in-place edit) is not allowed in read-only mode",
      };
    }
  }

  // `git` requires a read-only subcommand.
  if (binary === "git") {
    const tokens = segment.trimStart().split(/\s+/);
    // Skip the `git` token, find the first non-flag token.
    const subcommand = tokens.slice(1).find((t) => !t.startsWith("-"));
    if (!subcommand) {
      return { allowed: false, reason: "git requires a subcommand" };
    }
    if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
      return {
        allowed: false,
        reason: `git subcommand '${subcommand}' is not in the read-only allowlist`,
      };
    }
    // `git config` is read-only only for --get/--list (reads). Setting
    // values (--add, --unset, --replace-all, etc.) or bare key=value
    // assignments are writes.
    if (subcommand === "config") {
      const configArgs = tokens.slice(2).join(" ");
      // Write flags
      const configWriteRe = new RegExp(
        "--(add|unset|unset-all|replace-all|remove-section|rename-section)",
      );
      if (configWriteRe.test(configArgs)) {
        return {
          allowed: false,
          reason: "git config writes are not allowed in read-only mode",
        };
      }
      // Bare key=value assignment (e.g. `git config user.name 'foo'`)
      // Detect: if there's a key without --get/--get-all/--get-regexp/--list
      // and a value follows, it's a write.
      const configReadRe = new RegExp(
        "--(get|get-all|get-regexp|list|get-urlmatch)",
      );
      if (!configReadRe.test(configArgs)) {
        // If there are args beyond `config` and no read flag, it's a write.
        const nonFlagArgs = tokens.slice(2).filter((t) => !t.startsWith("-"));
        if (nonFlagArgs.length > 0) {
          return {
            allowed: false,
            reason: "git config writes are not allowed in read-only mode",
          };
        }
      }
    }
    // `git stash` is read-only only for `stash list` and `stash show`.
    // `stash drop`, `stash pop`, `stash clear`, `stash push` are writes.
    if (subcommand === "stash") {
      const stashSub = tokens.slice(2).find((t) => !t.startsWith("-"));
      if (stashSub && stashSub !== "list" && stashSub !== "show") {
        return {
          allowed: false,
          reason: `git stash ${stashSub} is not allowed in read-only mode`,
        };
      }
    }
    // `git remote add/remove/rename/set-url` are writes; bare `git remote`
    // or `git remote -v` are reads.
    if (subcommand === "remote") {
      const remoteSub = tokens.slice(2).find((t) => !t.startsWith("-"));
      if (remoteSub && remoteSub !== "show" && remoteSub !== "get-url") {
        return {
          allowed: false,
          reason: `git remote ${remoteSub} is not allowed in read-only mode`,
        };
      }
    }
  }

  // `find` with `-exec` or `-delete` or `-ok` allows arbitrary command
  // execution or filesystem mutation.
  if (binary === "find") {
    if (/\s-(exec|execdir|ok|okdir)\b/.test(segment)) {
      return {
        allowed: false,
        reason:
          "find -exec/-ok is not allowed in read-only mode (arbitrary command execution)",
      };
    }
    if (/\s-(delete|rm)\b/.test(segment)) {
      return {
        allowed: false,
        reason: "find -delete is not allowed in read-only mode",
      };
    }
  }

  // `awk` with `system()` or `print > "file"` can write files / exec commands.
  if (binary === "awk") {
    if (/system\s*\(/.test(segment)) {
      return {
        allowed: false,
        reason: "awk system() calls are not allowed in read-only mode",
      };
    }
    // Redirect inside awk: print > "file" or printf ... > "file"
    const awkRedirectRe = new RegExp(">\\s*[\"']");
    if (awkRedirectRe.test(segment)) {
      return {
        allowed: false,
        reason: "awk output redirection is not allowed in read-only mode",
      };
    }
  }

  // `tar`/`cp`/`mv`/`rm`/`chmod`/`chown`/`mkdir`/`rmdir`/`touch`/`tee`/
  // `dd`/`install`/`ln` are NOT in the allowlist, so they're already blocked.

  if (!READ_ONLY_COMMANDS.has(binary)) {
    return {
      allowed: false,
      reason: `command '${binary}' is not in the read-only allowlist`,
    };
  }

  return { allowed: true };
}

/**
 * Validate a full command string against the read-only shell policy.
 *
 * Checks metacharacters first (fast reject), then splits on pipes and
 * validates each segment.
 */
export function validateReadOnlyCommand(
  command: string,
): ReadOnlyShellValidationResult {
  // Fast reject on blocked metacharacters.
  for (const { pattern, reason } of BLOCKED_METACHARACTER_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: `blocked shell metacharacter: ${reason}`,
      };
    }
  }

  // Split on pipe — each piped segment must be validated independently.
  // We split on ` | ` (pipe surrounded by spaces) and `|` to handle both
  // `grep foo | wc -l` and `grep foo|wc -l`.
  const segments = command.split("|");

  for (const segment of segments) {
    const result = validateSegment(segment);
    if (!result.allowed) {
      return result;
    }
  }

  return { allowed: true };
}
