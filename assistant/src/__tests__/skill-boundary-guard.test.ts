import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { Glob } from "bun";

/**
 * Guard tests for the skill-isolation boundary. See AGENTS.md "Skill
 * Isolation". The end state is zero relative imports across `assistant/` ↔
 * `skills/` in both directions.
 *
 * The assistant → skills direction is currently `test.todo` because
 * `assistant/src/daemon/external-skills-bootstrap.ts` is a sanctioned
 * static import (required so `bun --compile` traces the first-party
 * meet-join skill into the binary). It converts to an active `test(...)`
 * once the bootstrap is deleted. Keeping it as `test.todo` rather than an
 * active assertion is required by AGENTS.md's "Never commit
 * normally-failing `test(...)` cases" rule.
 */

/** Resolve repo root (tests run from `assistant/`). */
function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

/**
 * Scan files matching `glob` (relative to repo root) for relative imports
 * reaching into `<targetDir>/`. Uses a multiline-capable regex over the
 * full file content so that imports split across lines (common for
 * `await import("../../../path")` wrapped by a formatter) are caught.
 */
function findRelativeImportViolations(
  glob: string,
  targetDir: string,
): string[] {
  const pattern = new RegExp(
    String.raw`\b(?:from|import)\s*\(?\s*["'](?:\.\./)+` +
      targetDir +
      String.raw`/`,
    "s",
  );
  const repoRoot = getRepoRoot();
  const violations: string[] = [];
  for (const relPath of new Glob(glob).scanSync({ cwd: repoRoot })) {
    const content = readFileSync(join(repoRoot, relPath), "utf-8");
    if (pattern.test(content)) violations.push(relPath);
  }
  return violations.sort();
}

describe("skill-isolation boundary", () => {
  test("no skills/** TypeScript file imports from assistant/** via relative path", () => {
    const violations = findRelativeImportViolations(
      "skills/**/*.ts",
      "assistant",
    );

    if (violations.length > 0) {
      const message = [
        "Found skills/ files that import assistant/ via relative path.",
        'Skills must wire into the daemon through a SkillHost — see AGENTS.md "Skill Isolation".',
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
      const violations = findRelativeImportViolations(
        "assistant/src/**/*.ts",
        "skills",
      );

      if (violations.length > 0) {
        const message = [
          "Found assistant/src/ files that import skills/ via relative path.",
          'Assistants must not reach into skills/ — see AGENTS.md "Skill Isolation".',
          "",
          "Violations:",
          ...violations.map((f) => `  - ${f}`),
        ].join("\n");

        expect(violations, message).toEqual([]);
      }
    },
  );
});
