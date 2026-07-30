/**
 * Shared plumbing for the repo's line-level writing checks.
 *
 * Both `check-generic-examples.ts` and `check-em-dashes.ts` answer the same
 * structural question - "which lines is this commit *adding*, and what does
 * each one say?" - and differ only in what they look for. This module owns the
 * common half: reading the staged (or PR-range) diff, parsing a commit message,
 * turning either into `AddedLine`s, and per-line suppression.
 *
 * Added lines only, deliberately. The rules these checks enforce apply to text
 * you write, not to text that already exists: AGENTS.md says em dashes are
 * "not swept retroactively - fix them on lines you are already changing and
 * leave the rest alone". Scanning the working tree instead of the diff would
 * turn every unrelated commit into a cleanup mandate.
 */

import { execSync } from "node:child_process";

export interface AddedLine {
  file: string;
  line: number;
  content: string;
  /** Line immediately preceding this one in the new file (for suppression lookup). */
  previousContent: string;
}

export type DiffMode = "staged" | "ci";

// -------- Files no writing rule applies to --------

/**
 * Generated, vendored, or machine-authored files. Nobody writes these by hand,
 * so a match in one is noise rather than a style violation.
 */
const SKIP_FILE_PATTERNS: RegExp[] = [
  /\.lock$/,
  /\.lockb$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /bun\.lock$/,
  /^CHANGELOG/,
  /\.snap$/,
  /node_modules\//,
  /^clients\/web\/src\/generated\//,
];

export function shouldSkipFile(
  file: string,
  extraPatterns: readonly RegExp[] = [],
): boolean {
  return (
    SKIP_FILE_PATTERNS.some((p) => p.test(file)) ||
    extraPatterns.some((p) => p.test(file))
  );
}

// -------- Diff parsing --------

export function parseUnifiedDiff(diff: string): AddedLine[] {
  const added: AddedLine[] = [];
  let currentFile = "";
  let currentNewLine = 0;
  // Track context lines so we can populate previousContent for each add.
  const recentContentByFile = new Map<string, Map<number, string>>();

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      // "+++ b/path/to/file" or "+++ /dev/null"
      const m = raw.match(/^\+\+\+ b\/(.+)$/);
      currentFile = m ? m[1]! : "";
      if (currentFile && !recentContentByFile.has(currentFile)) {
        recentContentByFile.set(currentFile, new Map());
      }
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        currentNewLine = parseInt(m[1]!, 10);
      }
      continue;
    }
    if (!currentFile) {
      continue;
    }

    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const content = raw.slice(1);
      const map = recentContentByFile.get(currentFile)!;
      added.push({
        file: currentFile,
        line: currentNewLine,
        content,
        previousContent: map.get(currentNewLine - 1) ?? "",
      });
      map.set(currentNewLine, content);
      currentNewLine++;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      // Removed line - does not advance the new-file counter.
    } else if (raw.startsWith(" ")) {
      // Context line - record for suppression lookup, advance counter.
      recentContentByFile.get(currentFile)!.set(currentNewLine, raw.slice(1));
      currentNewLine++;
    }
  }
  return added;
}

export function getDiff(mode: DiffMode): string {
  if (mode === "staged") {
    return execSync("git diff --cached --unified=1 --no-color", {
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  }
  // CI mode: diff the PR range. Prefer GitHub Actions env, fall back to
  // merge-base with origin/main.
  const base =
    process.env.GITHUB_BASE_REF ??
    execSync("git merge-base HEAD origin/main", { maxBuffer: 1024 * 1024 })
      .toString()
      .trim();
  const baseRef = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : base;
  return execSync(`git diff ${baseRef}...HEAD --unified=1 --no-color`, {
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

// -------- Commit-message parsing --------

/** Git inserts this via `git commit --verbose`; everything below is dropped. */
const COMMIT_MSG_SCISSORS =
  "# ------------------------ >8 ------------------------";

/**
 * `verbatim` and `whitespace` cleanup modes keep `#` lines in the recorded
 * message, so we cannot blindly skip them. `default`/`strip`/`scissors` drop
 * them, so skipping avoids false positives on git editor template text.
 */
const DROPS_HASH_LINES: ReadonlySet<string> = new Set([
  "default",
  "strip",
  "scissors",
]);

export function getCommitCleanupMode(): string {
  try {
    const value = execSync("git config --get commit.cleanup", {
      stdio: ["pipe", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return value || "default";
  } catch {
    return "default";
  }
}

export function parseCommitMessage(
  text: string,
  cleanupMode: string = getCommitCleanupMode(),
): AddedLine[] {
  const result: AddedLine[] = [];
  const lines = text.split("\n");
  const dropsHashLines = DROPS_HASH_LINES.has(cleanupMode);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    // The scissors line and everything below it come from `git commit -v` and
    // are dropped before the commit is recorded - that region holds the
    // verbose diff, so scanning it would flag staged code as commit text.
    if (raw === COMMIT_MSG_SCISSORS) {
      break;
    }
    if (dropsHashLines && raw.startsWith("#")) {
      continue;
    }
    // No previousContent: a prior-line suppression marker in a commit message
    // would survive into the recorded message, which is odd UX. Same-line
    // markers still work.
    result.push({
      file: "(commit message)",
      line: i + 1,
      content: raw,
      previousContent: "",
    });
  }
  return result;
}

// -------- Suppression --------

/**
 * True when a line opts out, either on itself (`<rule>:ignore-line`) or via a
 * marker on the line above (`<rule>:ignore-next-line`).
 */
export function isSuppressed(line: AddedLine, rule: string): boolean {
  return (
    line.content.includes(`${rule}:ignore-line`) ||
    line.previousContent.includes(`${rule}:ignore-next-line`)
  );
}
