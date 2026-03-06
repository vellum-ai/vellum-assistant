import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * Guard test: prevent stale lifecycle instructions from being reintroduced
 * into documentation. The canonical lifecycle commands are `assistant wake`,
 * `assistant ps`, and `assistant sleep`. Repo-local slash commands live in
 * `.claude/skills/`, not `.claude/commands/`.
 *
 * See AGENTS.md for the conventions these tests enforce.
 */

const REPO_ROOT = join(import.meta.dir, "../../..");

describe("lifecycle docs guard", () => {
  it("repo-local commands live in skills directory, not commands directory", () => {
    const staleLocations = [
      ".claude/commands/update.md",
      ".claude/commands/release.md",
    ];

    const violations = staleLocations.filter((p) =>
      existsSync(join(REPO_ROOT, p)),
    );

    if (violations.length > 0) {
      const message = [
        "Found repo-local commands in .claude/commands/ — they should live in .claude/skills/.",
        "",
        "Stale files:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "Move them to .claude/skills/<name>/SKILL.md instead.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }

    // Verify the correct locations exist
    const expectedLocations = [
      ".claude/skills/update/SKILL.md",
      ".claude/skills/release/SKILL.md",
    ];

    const missing = expectedLocations.filter(
      (p) => !existsSync(join(REPO_ROOT, p)),
    );

    if (missing.length > 0) {
      const message = [
        "Expected repo-local skill files are missing:",
        ...missing.map((f) => `  - ${f}`),
      ].join("\n");

      expect(missing, message).toEqual([]);
    }
  });

  it("key docs reference assistant lifecycle commands", () => {
    const checks: Array<{
      file: string;
      pattern: string;
      description: string;
    }> = [
      {
        file: "README.md",
        pattern: "assistant wake\\|assistant ps\\|assistant sleep",
        description:
          "README.md should mention assistant wake, assistant ps, or assistant sleep",
      },
      {
        file: "assistant/README.md",
        pattern: "assistant wake\\|assistant ps",
        description:
          "assistant/README.md should mention assistant wake or assistant ps",
      },
      {
        file: "AGENTS.md",
        pattern: "assistant ps\\|assistant sleep\\|assistant wake",
        description:
          "AGENTS.md should mention assistant ps, assistant sleep, or assistant wake in the /update command description",
      },
    ];

    const failures: string[] = [];

    for (const check of checks) {
      try {
        execSync(`git grep -q '${check.pattern}' -- '${check.file}'`, {
          encoding: "utf-8",
          cwd: REPO_ROOT,
        });
      } catch {
        failures.push(check.description);
      }
    }

    if (failures.length > 0) {
      const message = [
        "Key docs are missing assistant lifecycle command references:",
        "",
        ...failures.map((f) => `  - ${f}`),
        "",
        "These docs should reference assistant CLI lifecycle commands (wake/ps/sleep).",
      ].join("\n");

      expect(failures, message).toEqual([]);
    }
  });

  it("no docs use stale daemon startup as primary instruction", () => {
    // Files that are allowed to contain these patterns
    const allowedPrefixes = [
      "cli/", // CLI source code
      "assistant/src/", // assistant runtime source
      "CLAUDE.md", // project instructions
      "AGENTS.md", // agent conventions (may reference patterns for context)
    ];

    const stalePatterns = [
      {
        pattern: "bun run src/index.ts daemon start",
        label: "bun run src/index.ts daemon start",
      },
    ];

    const violations: string[] = [];

    for (const { pattern, label } of stalePatterns) {
      let grepOutput = "";
      try {
        grepOutput = execSync(`git grep -n '${pattern}' -- '*.md'`, {
          encoding: "utf-8",
          cwd: REPO_ROOT,
        }).trim();
      } catch {
        // No matches — happy path
        continue;
      }

      const lines = grepOutput.split("\n").filter((l) => l.length > 0);

      for (const line of lines) {
        const filePath = line.split(":")[0];

        // Skip allowed file prefixes
        if (allowedPrefixes.some((prefix) => filePath.startsWith(prefix))) {
          continue;
        }

        // Skip test files
        if (filePath.includes("__tests__") || filePath.endsWith(".test.ts")) {
          continue;
        }

        // Check if this specific occurrence is inside a <details> section or
        // a "Development" / "raw bun commands" context by examining only the
        // 10 lines before this match. We extract the line number from the
        // grep output (format "filePath:lineNum:content") and use sed to
        // get a targeted range, so each match is evaluated independently.
        const parts = line.split(":");
        const lineNum = parseInt(parts[1], 10);

        if (!Number.isNaN(lineNum)) {
          try {
            const startLine = Math.max(1, lineNum - 10);
            const context = execSync(
              `sed -n '${startLine},${lineNum}p' '${filePath}'`,
              { encoding: "utf-8", cwd: REPO_ROOT },
            );

            const contextLower = context.toLowerCase();
            const isInDetails = contextLower.includes("<details>");
            const isDevContext =
              contextLower.includes("development:") ||
              contextLower.includes("low-level development") ||
              contextLower.includes("raw bun commands");

            if (isInDetails || isDevContext) {
              continue;
            }
          } catch {
            // If context extraction fails, treat as a violation
          }
        }

        violations.push(
          `${filePath}: contains "${label}" as primary instruction`,
        );
      }
    }

    if (violations.length > 0) {
      const message = [
        "Found docs using stale daemon startup patterns as primary instructions.",
        "Use `assistant wake` / `assistant sleep` instead. Raw bun commands are acceptable",
        "only in collapsed <details> sections or dev-only contexts.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });
});
