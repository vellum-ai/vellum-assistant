#!/usr/bin/env bun
/**
 * Enforces the "Generic Examples" rule from AGENTS.md: test fixtures,
 * examples, and dialogue data must use generic placeholders rather than
 * real personal data. Runs from the pre-commit hook on staged changes.
 *
 * The in-repo patterns are shape-based (email/phone formats). Contributors
 * who want to block additional terms can drop them into a local config
 * outside the repo — see scripts/generic-examples/README.md.
 *
 * Usage:
 *   bun scripts/check-generic-examples.ts              # scan staged changes
 *   bun scripts/check-generic-examples.ts --ci         # scan HEAD..origin/main (for CI use)
 *   bun scripts/check-generic-examples.ts --self-test  # run built-in tests
 *
 * Bypass a single line: add `// generic-examples:ignore-next-line — reason: X`
 * on the line above. Bypass the whole commit: `git commit --no-verify`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

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
      /["'`](?:\+?1[-. ]?)?\(?(?!555\)?[-. ]?01\d\d)\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}["'`]/,
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

// -------- Diff parsing --------

interface AddedLine {
  file: string;
  line: number;
  content: string;
  /** Line immediately preceding this one in the new file (for suppression lookup). */
  previousContent: string;
}

const SKIP_FILE_PATTERNS: RegExp[] = [
  /^scripts\/generic-examples\//,
  /^scripts\/check-generic-examples\.ts$/,
  /^\.githooks\/pre-commit$/,
  /\.lock$/,
  /\.lockb$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /bun\.lock$/,
  /^CHANGELOG/,
  /\.snap$/,
  /node_modules\//,
];

function shouldSkipFile(file: string): boolean {
  return SKIP_FILE_PATTERNS.some((p) => p.test(file));
}

function parseUnifiedDiff(diff: string): AddedLine[] {
  const added: AddedLine[] = [];
  let currentFile = "";
  let currentNewLine = 0;
  // Track context lines so we can populate previousContent for each add.
  const recentContentByFile = new Map<string, Map<number, string>>();

  const lines = diff.split("\n");
  for (const raw of lines) {
    if (raw.startsWith("+++ ")) {
      // "+++ b/path/to/file" or "+++ /dev/null"
      const m = raw.match(/^\+\+\+ b\/(.+)$/);
      currentFile = m ? m[1] : "";
      if (currentFile && !recentContentByFile.has(currentFile)) {
        recentContentByFile.set(currentFile, new Map());
      }
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) currentNewLine = parseInt(m[1], 10);
      continue;
    }
    if (!currentFile) continue;

    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const content = raw.slice(1);
      const map = recentContentByFile.get(currentFile)!;
      const previousContent = map.get(currentNewLine - 1) ?? "";
      map.set(currentNewLine, content);
      added.push({
        file: currentFile,
        line: currentNewLine,
        content,
        previousContent,
      });
      currentNewLine++;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      // Removed line — does not advance new-file counter.
    } else if (raw.startsWith(" ")) {
      // Context line — record for suppression lookup, advance counter.
      recentContentByFile.get(currentFile)!.set(currentNewLine, raw.slice(1));
      currentNewLine++;
    }
  }
  return added;
}

function getDiff(mode: "staged" | "ci"): string {
  if (mode === "staged") {
    return execSync("git diff --cached --unified=0 --no-color", {
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  }
  // CI mode: diff the PR range. Prefer GitHub Actions env, fall back to
  // merge-base with origin/main.
  const base =
    process.env.GITHUB_BASE_REF ??
    execSync("git merge-base HEAD origin/main", {
      maxBuffer: 1024 * 1024,
    })
      .toString()
      .trim();
  const baseRef = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : base;
  return execSync(
    `git diff ${baseRef}...HEAD --unified=0 --no-color`,
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  ).toString();
}

// -------- Suppression --------

function isSuppressed(line: AddedLine): boolean {
  if (line.content.includes("generic-examples:ignore-line")) return true;
  if (line.previousContent.includes("generic-examples:ignore-next-line")) {
    return true;
  }
  return false;
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
    name: "reserved phone is OK",
    content: `const n = "555-0142";`,
    expectPatterns: [],
  },
  {
    name: "real phone is flagged",
    content: `const n = "212-555-1234";`,
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
  const total = TEST_CASES.length;
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

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return runSelfTest();

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
