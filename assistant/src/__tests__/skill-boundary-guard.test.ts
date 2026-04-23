import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Guard tests for the skill-isolation boundary. See CLAUDE.md "Skill
 * Isolation". The end state is zero relative imports across `assistant/` ↔
 * `skills/` in both directions.
 *
 * The assistant → skills direction is currently `test.todo` because
 * `assistant/src/daemon/external-skills-bootstrap.ts` is a sanctioned
 * static import (required so `bun --compile` traces the first-party
 * meet-join skill into the binary). It converts to an active `test(...)`
 * once the bootstrap is deleted. Keeping it as `test.todo` rather than an
 * active assertion is required by CLAUDE.md's "Never commit
 * normally-failing `test(...)` cases" rule.
 */

/** Resolve repo root (tests run from `assistant/`). */
function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

/**
 * Run `git grep -lE <pattern> -- <globs>` from the repo root and return the
 * list of matching file paths. Treats exit code 1 ("no matches") as the
 * happy path and returns an empty array.
 */
function gitGrepFiles(pattern: string, globs: string[]): string[] {
  try {
    const output = execFileSync(
      "git",
      ["grep", "-lE", pattern, "--", ...globs],
      { encoding: "utf-8", cwd: getRepoRoot() },
    ).trim();
    return output.length > 0 ? output.split("\n") : [];
  } catch (err) {
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

/**
 * Matches TypeScript imports (including side-effect `import "..."` and
 * dynamic `import("...")`) whose module specifier starts with one or more
 * `../` segments and then a `<dir>/` segment. We anchor on the quote so
 * line-comments that merely mention the pattern in prose do not match.
 *
 * The `<dir>` placeholder is interpolated per-test (either `assistant` or
 * `skills`).
 */
function relativeImportPattern(dir: string): string {
  return `(from|import)[[:space:]]*\\(?["'](\\.\\./)+${dir}/`;
}

describe("skill-isolation boundary", () => {
  test("no skills/** TypeScript file imports from assistant/** via relative path", () => {
    const violations = gitGrepFiles(relativeImportPattern("assistant"), [
      "skills/**/*.ts",
    ]);

    if (violations.length > 0) {
      const message = [
        "Found skills/ files that import assistant/ via relative path.",
        'Skills must wire into the daemon through a SkillHost — see CLAUDE.md "Skill Isolation".',
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "To fix: inject the needed capability through `SkillHost` (logger,",
        "events, registries, providers, etc.) instead of reaching into",
        "`assistant/` directly.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  // Deferred until `external-skills-bootstrap.ts` is deleted — see the
  // file-level doc block. Body is pre-written so the flip is a `.todo` → `test`
  // edit rather than a behavior change.
  test.todo(
    "no assistant/src/** TypeScript file imports from skills/** via relative path",
    () => {
      const violations = gitGrepFiles(relativeImportPattern("skills"), [
        "assistant/src/**/*.ts",
      ]);

      if (violations.length > 0) {
        const message = [
          "Found assistant/src/ files that import skills/ via relative path.",
          'Assistants must not reach into skills/ — see CLAUDE.md "Skill Isolation".',
          "",
          "Violations:",
          ...violations.map((f) => `  - ${f}`),
        ].join("\n");

        expect(violations, message).toEqual([]);
      }
    },
  );
});
