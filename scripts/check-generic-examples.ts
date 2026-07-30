#!/usr/bin/env bun
/**
 * Enforces the "Generic Examples" rule from AGENTS.md: test fixtures,
 * examples, and dialogue data must use generic placeholders rather than
 * real personal data. Runs from the pre-commit hook on staged changes
 * and from the commit-msg hook on the message text itself.
 *
 * The in-repo patterns are shape-based (email/phone formats). Contributors
 * who want to block additional terms can drop them into a local config
 * outside the repo — see scripts/generic-examples/README.md.
 *
 * Usage:
 *   bun scripts/check-generic-examples.ts                    # scan staged changes
 *   bun scripts/check-generic-examples.ts --ci               # scan HEAD..origin/main (for CI use)
 *   bun scripts/check-generic-examples.ts --commit-msg PATH  # scan a commit message file
 *   bun scripts/check-generic-examples.ts --self-test        # run built-in tests
 *
 * Bypass a single line: add `// generic-examples:ignore-next-line — reason: X`
 * on the line above. Bypass the whole commit: `git commit --no-verify`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

import {
  getDiff,
  isSuppressed as isSuppressedBy,
  parseCommitMessage,
  parseUnifiedDiff,
  shouldSkipFile as shouldSkipSharedFile,
  type AddedLine,
} from "./lib/staged-text-scan";

type Severity = "BLOCK" | "WARN";

interface Pattern {
  name: string;
  regex: RegExp;
  severity: Severity;
  description: string;
}

interface PrivatePatternConfig {
  name: string;
  regex: string;
  flags?: string;
  severity?: Severity;
  description?: string;
}

interface Finding {
  file: string;
  line: number;
  content: string;
  pattern: string;
  severity: Severity;
  description: string;
}

// -------- Public shape patterns (safe to ship in the repo) --------

const SHAPE_PATTERNS: Pattern[] = [
  {
    name: "non-example-email",
    // Email address in a string/quote context that is NOT on a reserved
    // example domain. Matches common quoting styles (', ", `).
    regex:
      /["'`]([A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,})["'`]/,
    severity: "BLOCK",
    description:
      "email that is not on example.com/example.org (use user@example.com in fixtures)",
  },
  {
    name: "non-reserved-phone",
    // North American phone number inside a string literal whose last seven
    // digits do NOT fall in the reserved 555-0100..555-0199 range that IANA
    // allocates for fiction. Matches common formats including (xxx) xxx-xxxx.
    regex:
      /["'`](?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?(?!555[-. ]?01\d\d)\d{3}[-. ]?\d{4}["'`]/,
    severity: "WARN",
    description:
      "phone number outside the reserved 555-01XX range (use 555-01xx in fixtures)",
  },
];

// -------- Private pattern loader (from outside the repo) --------

function privateConfigPath(): string {
  if (process.env.VELLUM_CONTENT_CHECK_PATTERNS) {
    return process.env.VELLUM_CONTENT_CHECK_PATTERNS;
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "vellum-content-check", "patterns.json");
}

function loadPrivatePatterns(): Pattern[] {
  const path = privateConfigPath();
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    process.stderr.write(
      `warning: could not parse private patterns at ${path}: ${String(err)}\n`,
    );
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const patterns: Pattern[] = [];
  for (const entry of raw as PrivatePatternConfig[]) {
    if (!entry || typeof entry.regex !== "string" || !entry.name) continue;
    try {
      patterns.push({
        name: entry.name,
        regex: new RegExp(entry.regex, entry.flags ?? "i"),
        severity: entry.severity ?? "BLOCK",
        description: entry.description ?? "private pattern",
      });
    } catch (err) {
      process.stderr.write(
        `warning: invalid regex in private pattern "${entry.name}": ${String(err)}\n`,
      );
    }
  }
  return patterns;
}

// -------- Files this rule additionally skips --------

/**
 * On top of the shared skips (lockfiles, generated output, snapshots): the
 * rule's own machinery, whose patterns and fixtures necessarily contain the
 * shapes it matches on.
 */
const SKIP_FILE_PATTERNS: RegExp[] = [
  /^scripts\/generic-examples\//,
  /^scripts\/check-generic-examples\.ts$/,
  /^\.githooks\/(pre-commit|commit-msg)$/,
];

function shouldSkipFile(file: string): boolean {
  return shouldSkipSharedFile(file, SKIP_FILE_PATTERNS);
}

function isSuppressed(line: AddedLine): boolean {
  return isSuppressedBy(line, "generic-examples");
}

// -------- Matching --------

function scan(
  added: AddedLine[],
  patterns: Pattern[],
): Finding[] {
  const findings: Finding[] = [];
  for (const line of added) {
    if (shouldSkipFile(line.file)) continue;
    if (isSuppressed(line)) continue;
    for (const pattern of patterns) {
      if (pattern.regex.test(line.content)) {
        findings.push({
          file: line.file,
          line: line.line,
          content: line.content.trim(),
          pattern: pattern.name,
          severity: pattern.severity,
          description: pattern.description,
        });
      }
    }
  }
  return findings;
}

// -------- Output --------

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const NC = "\x1b[0m";

function truncate(s: string, max = 160): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function printFindings(findings: Finding[]): void {
  const blocks = findings.filter((f) => f.severity === "BLOCK");
  const warns = findings.filter((f) => f.severity === "WARN");
  const bar = "━".repeat(60);

  if (blocks.length > 0) {
    process.stderr.write(`\n${RED}${bar}${NC}\n`);
    process.stderr.write(
      `${RED}Generic-examples rule violations (commit blocked):${NC}\n`,
    );
    process.stderr.write(`${RED}${bar}${NC}\n\n`);
    for (const f of blocks) {
      process.stderr.write(`  ${f.file}:${f.line}\n`);
      process.stderr.write(`    ${f.pattern}: ${f.description}\n`);
      process.stderr.write(`    ${truncate(f.content)}\n\n`);
    }
  }
  if (warns.length > 0) {
    process.stderr.write(`\n${YELLOW}${bar}${NC}\n`);
    process.stderr.write(
      `${YELLOW}Possible generic-examples issues (review before committing):${NC}\n`,
    );
    process.stderr.write(`${YELLOW}${bar}${NC}\n\n`);
    for (const f of warns) {
      process.stderr.write(`  ${f.file}:${f.line}\n`);
      process.stderr.write(`    ${f.pattern}: ${f.description}\n`);
      process.stderr.write(`    ${truncate(f.content)}\n\n`);
    }
  }

  if (blocks.length > 0 || warns.length > 0) {
    process.stderr.write(
      `See AGENTS.md "Generic Examples" for the rule. To suppress a single line, add\n` +
        `  // generic-examples:ignore-next-line — reason: <why>\n` +
        `above it. To bypass the whole hook: git commit --no-verify.\n\n`,
    );
  }
}

// -------- Self-test --------

interface TestCase {
  name: string;
  content: string;
  previousContent?: string;
  expectPatterns: string[];
}

const TEST_CASES: TestCase[] = [
  {
    name: "generic email is OK",
    content: `const to = "user@example.com";`,
    expectPatterns: [],
  },
  {
    name: "real-domain email is flagged",
    content: `const to = "alice@gmail.com";`,
    expectPatterns: ["non-example-email"],
  },
  {
    name: "reserved 10-digit phone is OK",
    content: `const n = "212-555-0142";`,
    expectPatterns: [],
  },
  {
    name: "reserved 10-digit phone with parens is OK",
    content: `const n = "(212) 555-0142";`,
    expectPatterns: [],
  },
  {
    name: "real 10-digit phone is flagged",
    content: `const n = "212-555-1234";`,
    expectPatterns: ["non-reserved-phone"],
  },
  {
    name: "real 10-digit phone with parens is flagged",
    content: `const n = "(212) 555-9999";`,
    expectPatterns: ["non-reserved-phone"],
  },
  {
    name: "inline suppression on same line",
    content: `to: "alice@gmail.com" // generic-examples:ignore-line — test fixture`,
    expectPatterns: [],
  },
  {
    name: "inline suppression on previous line",
    previousContent: `// generic-examples:ignore-next-line — allowed in this test`,
    content: `to: "alice@gmail.com"`,
    expectPatterns: [],
  },
];

interface CommitMsgTestCase {
  name: string;
  text: string;
  cleanupMode?: string;
  expectPatterns: string[];
}

const COMMIT_MSG_TEST_CASES: CommitMsgTestCase[] = [
  {
    name: "clean message passes",
    text: 'fix: handle null user\n\nCloses JARVIS-123\n',
    expectPatterns: [],
  },
  {
    name: "quoted real email in body is flagged",
    text: 'fix: migrate user\n\nMigrating "alice@gmail.com" to org table.\n',
    expectPatterns: ["non-example-email"],
  },
  {
    name: "quoted example email in body is OK",
    text: 'fix: migrate user\n\nMigrating "user@example.com" to org table.\n',
    expectPatterns: [],
  },
  {
    name: "comment line containing quoted real email is skipped under default cleanup",
    text: 'fix: bug\n\n# note: was "alice@gmail.com"\n',
    expectPatterns: [],
  },
  {
    name: "comment line containing quoted real email is flagged under verbatim cleanup",
    text: 'fix: bug\n\n# note: was "alice@gmail.com"\n',
    cleanupMode: "verbatim",
    expectPatterns: ["non-example-email"],
  },
  {
    name: "comment line containing quoted real email is flagged under whitespace cleanup",
    text: 'fix: bug\n\n# note: was "alice@gmail.com"\n',
    cleanupMode: "whitespace",
    expectPatterns: ["non-example-email"],
  },
  {
    name: "scissors line truncates scan",
    text:
      'fix: bug\n\n' +
      '# ------------------------ >8 ------------------------\n' +
      '# Do not modify or remove the line above.\n' +
      'diff --git a/file.ts b/file.ts\n' +
      '+const e = "alice@gmail.com";\n',
    expectPatterns: [],
  },
  {
    name: "content below scissors line is ignored under verbatim cleanup (verbose diff is never recorded)",
    text:
      'fix: bug\n\n' +
      '# ------------------------ >8 ------------------------\n' +
      'diff --git a/file.ts b/file.ts\n' +
      '+const e = "alice@gmail.com";\n',
    cleanupMode: "verbatim",
    expectPatterns: [],
  },
  {
    name: "content below scissors line is ignored under whitespace cleanup (verbose diff is never recorded)",
    text:
      'fix: bug\n\n' +
      '# ------------------------ >8 ------------------------\n' +
      'diff --git a/file.ts b/file.ts\n' +
      '+const e = "alice@gmail.com";\n',
    cleanupMode: "whitespace",
    expectPatterns: [],
  },
  {
    name: "Co-Authored-By trailer with angle-bracketed email is OK",
    text:
      'fix: bug\n\n' +
      'Co-Authored-By: Claude <noreply@anthropic.com>\n',
    expectPatterns: [],
  },
];

function runSelfTest(): number {
  let failed = 0;
  for (const tc of TEST_CASES) {
    const added: AddedLine = {
      file: "some/file.ts",
      line: 10,
      content: tc.content,
      previousContent: tc.previousContent ?? "",
    };
    const findings = scan([added], SHAPE_PATTERNS);
    const got = findings.map((f) => f.pattern).sort();
    const want = [...tc.expectPatterns].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failed++;
      process.stderr.write(
        `FAIL: ${tc.name}\n  want: ${want.join(", ") || "(none)"}\n  got:  ${got.join(", ") || "(none)"}\n`,
      );
    }
  }
  for (const tc of COMMIT_MSG_TEST_CASES) {
    const lines = parseCommitMessage(tc.text, tc.cleanupMode ?? "default");
    const findings = scan(lines, SHAPE_PATTERNS);
    const got = findings.map((f) => f.pattern).sort();
    const want = [...tc.expectPatterns].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failed++;
      process.stderr.write(
        `FAIL (commit-msg): ${tc.name}\n  want: ${want.join(", ") || "(none)"}\n  got:  ${got.join(", ") || "(none)"}\n`,
      );
    }
  }
  const total = TEST_CASES.length + COMMIT_MSG_TEST_CASES.length;
  if (failed === 0) {
    process.stdout.write(`${total}/${total} self-tests passed\n`);
    return 0;
  }
  process.stderr.write(`\n${failed}/${total} self-tests FAILED\n`);
  return 1;
}

// -------- Entry --------

async function promptContinue(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  process.stderr.write("Continue with these warnings? [y/N] ");
  return new Promise<boolean>((res) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (buf) => {
      const ans = buf.toString().trim().toLowerCase();
      res(ans === "y" || ans === "yes");
    });
  });
}

async function runCommitMsgMode(path: string): Promise<number> {
  const absPath = resolve(path);
  if (!existsSync(absPath)) {
    process.stderr.write(`error: commit message file not found: ${absPath}\n`);
    return 1;
  }
  const text = readFileSync(absPath, "utf8");
  const lines = parseCommitMessage(text);
  if (lines.length === 0) return 0;

  const patterns = [...SHAPE_PATTERNS, ...loadPrivatePatterns()];
  const findings = scan(lines, patterns);
  if (findings.length === 0) return 0;

  printFindings(findings);

  const blocks = findings.filter((f) => f.severity === "BLOCK");
  if (blocks.length > 0) return 1;

  // Warnings only.
  const proceed = await promptContinue();
  return proceed ? 0 : 1;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return runSelfTest();

  const commitMsgIdx = args.indexOf("--commit-msg");
  if (commitMsgIdx >= 0) {
    const path = args[commitMsgIdx + 1];
    if (!path) {
      process.stderr.write(
        "error: --commit-msg requires a file path argument\n",
      );
      return 1;
    }
    return runCommitMsgMode(path);
  }

  // Change to repo root so git commands work regardless of cwd.
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      maxBuffer: 1024 * 1024,
    })
      .toString()
      .trim();
    process.chdir(root);
  } catch {
    process.stderr.write("error: not a git repository\n");
    return 1;
  }

  const mode: "staged" | "ci" = args.includes("--ci") ? "ci" : "staged";
  const diff = getDiff(mode);
  if (!diff.trim()) return 0;

  const patterns = [...SHAPE_PATTERNS, ...loadPrivatePatterns()];
  const added = parseUnifiedDiff(diff);
  const findings = scan(added, patterns);
  if (findings.length === 0) return 0;

  printFindings(findings);

  const blocks = findings.filter((f) => f.severity === "BLOCK");
  if (blocks.length > 0) return 1;

  // Warnings only.
  if (mode === "ci") return 1;
  const proceed = await promptContinue();
  return proceed ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`check-generic-examples: fatal: ${String(err)}\n`);
    process.exit(2);
  });
