#!/usr/bin/env bun
/**
 * Enforces the "Em Dashes" rule from AGENTS.md: never use an em dash (U+2014).
 * The rule covers everything we write - user-facing copy, code comments,
 * documentation, commit messages, and PR descriptions - and the strictest case
 * is UI copy, because the assistant's own system prompt forbids em dashes, so a
 * string a user reads is written in a different voice from the assistant
 * standing next to it.
 *
 * Scans only the lines a commit *adds*, matching the rule's own scope:
 * "Existing text is not swept retroactively. Fix em dashes on lines you are
 * already changing and leave the rest alone."
 *
 * Usage:
 *   bun scripts/check-em-dashes.ts                    # scan staged changes
 *   bun scripts/check-em-dashes.ts --ci               # scan the PR range
 *   bun scripts/check-em-dashes.ts --commit-msg PATH  # scan a commit message
 *   bun scripts/check-em-dashes.ts --self-test        # run built-in tests
 *
 * Bypass one line: `em-dashes:ignore-line - reason: X` on the line, or
 * `em-dashes:ignore-next-line - reason: X` above it. Bypass a whole commit:
 * `git commit --no-verify`.
 */

import { readFileSync } from "node:fs";

import {
  getDiff,
  isSuppressed,
  parseCommitMessage,
  parseUnifiedDiff,
  shouldSkipFile,
  type AddedLine,
  type DiffMode,
} from "./lib/staged-text-scan";

const EM_DASH = "—";
const RULE = "em-dashes";

/**
 * Files that legitimately contain the character: the rule's own documentation
 * has to name it, and this checker plus its tests have to match on it.
 */
const SKIP_FILE_PATTERNS: RegExp[] = [
  /^AGENTS\.md$/,
  /^scripts\/check-em-dashes\.ts$/,
  /^scripts\/lib\/staged-text-scan\.ts$/,
  /^\.githooks\/(pre-commit|commit-msg)$/,
];

interface Finding {
  file: string;
  line: number;
  content: string;
  column: number;
}

function scan(added: AddedLine[]): Finding[] {
  const findings: Finding[] = [];
  for (const line of added) {
    if (line.file !== "(commit message)" && shouldSkipFile(line.file, SKIP_FILE_PATTERNS)) {
      continue;
    }
    const column = line.content.indexOf(EM_DASH);
    if (column === -1 || isSuppressed(line, RULE)) {
      continue;
    }
    findings.push({
      file: line.file,
      line: line.line,
      content: line.content,
      column: column + 1,
    });
  }
  return findings;
}

/**
 * The replacement to suggest. A spaced em dash reads as a spaced hyphen; a
 * tight one (`a—b`) reads as a plain hyphen. Anything more contextual than
 * that is the author's call, so the message offers rather than rewrites.
 */
function suggest(content: string): string {
  return content.replace(` ${EM_DASH} `, " - ").replaceAll(EM_DASH, "-");
}

function truncate(s: string, max = 160): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function printFindings(findings: Finding[]): void {
  process.stderr.write(
    `\n[31m✖ Em dash (U+2014) in ${findings.length} added line${
      findings.length === 1 ? "" : "s"
    }[0m\n\n`,
  );
  for (const f of findings) {
    process.stderr.write(`  ${f.file}:${f.line}:${f.column}\n`);
    process.stderr.write(`    ${truncate(f.content.trim())}\n`);
    const fixed = suggest(f.content).trim();
    if (fixed !== f.content.trim()) {
      process.stderr.write(`    [32m${truncate(fixed)}[0m\n`);
    }
    process.stderr.write("\n");
  }
  process.stderr.write(
    "AGENTS.md (\"Em Dashes\"): use a period, comma, colon, parentheses, or a\n" +
      "plain hyphen instead. Applies to code comments, docs, UI copy, and commit\n" +
      "messages. Only lines this commit adds are checked - existing text is left\n" +
      "alone.\n\n" +
      `To allow one deliberately, put \`${RULE}:ignore-next-line - reason: <why>\`\n` +
      "on the line above (or `" +
      `${RULE}:ignore-line\` on the line itself).\n\n`,
  );
}

// -------- Self-test --------

interface TestCase {
  name: string;
  content: string;
  previousContent?: string;
  file?: string;
  expectFinding: boolean;
}

const TEST_CASES: TestCase[] = [
  {
    name: "plain em dash is caught",
    content: "// this is a comment — with an em dash",
    expectFinding: true,
  },
  {
    name: "hyphen is fine",
    content: "// this is a comment - with a hyphen",
    expectFinding: false,
  },
  {
    name: "en dash is not an em dash",
    content: "// a range 1–2",
    expectFinding: false,
  },
  {
    name: "same-line suppression",
    content: `const s = "a — b"; // ${RULE}:ignore-line - reason: quoted source`,
    expectFinding: false,
  },
  {
    name: "previous-line suppression",
    content: 'const s = "a — b";',
    previousContent: `// ${RULE}:ignore-next-line - reason: quoted source`,
    expectFinding: false,
  },
  {
    name: "AGENTS.md is exempt (it documents the rule)",
    content: "Never use em dashes (—).",
    file: "AGENTS.md",
    expectFinding: false,
  },
  {
    name: "generated output is exempt",
    content: "const x = \"—\";",
    file: "clients/web/src/generated/daemon/types.gen.ts",
    expectFinding: false,
  },
  {
    name: "lockfiles are exempt",
    content: "resolved — whatever",
    file: "bun.lock",
    expectFinding: false,
  },
  {
    name: "commit message text is checked",
    content: "feat: add a thing — and another",
    file: "(commit message)",
    expectFinding: true,
  },
];

function runSelfTest(): number {
  let failed = 0;
  for (const tc of TEST_CASES) {
    const findings = scan([
      {
        file: tc.file ?? "some/file.ts",
        line: 10,
        content: tc.content,
        previousContent: tc.previousContent ?? "",
      },
    ]);
    const got = findings.length > 0;
    if (got !== tc.expectFinding) {
      failed++;
      process.stderr.write(
        `FAIL ${tc.name}: expected ${tc.expectFinding ? "a finding" : "no finding"}, got ${got}\n`,
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

function main(): number {
  const args = process.argv.slice(2);

  if (args.includes("--self-test")) {
    return runSelfTest();
  }

  const commitMsgIdx = args.indexOf("--commit-msg");
  if (commitMsgIdx >= 0) {
    const path = args[commitMsgIdx + 1];
    if (!path) {
      process.stderr.write("error: --commit-msg requires a file path\n");
      return 2;
    }
    const findings = scan(parseCommitMessage(readFileSync(path, "utf8")));
    if (findings.length === 0) {
      return 0;
    }
    printFindings(findings);
    return 1;
  }

  const mode: DiffMode = args.includes("--ci") ? "ci" : "staged";
  const findings = scan(parseUnifiedDiff(getDiff(mode)));
  if (findings.length === 0) {
    return 0;
  }
  printFindings(findings);
  return 1;
}

process.exit(main());
