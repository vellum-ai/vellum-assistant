import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { Glob } from "bun";

/**
 * Guard tests for the skill-isolation boundary. See AGENTS.md "Skill
 * Isolation". Both directions are enforced: zero relative imports across
 * `assistant/` ↔ `skills/`. Skills wire into the daemon through the
 * `SkillHost` contract in `@vellumai/skill-host-contracts`; the daemon
 * loads first-party skills as separate processes via the manifest in
 * `meet-host-startup.ts`.
 *
 * Note: `assistant/src/skills/` is the internal skill-catalog loader and
 * is NOT a violation when referenced via `../skills/...` from within
 * `assistant/src/`. The guard resolves each import path and only reports
 * imports whose resolved target is the repo-root `skills/` directory.
 */

/** Resolve repo root (tests run from `assistant/`). */
function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

/**
 * Scan files matching `glob` for relative imports of `<targetDir>/`,
 * resolve each import to an absolute path, and report only those that
 * land inside the repo-root `<targetDir>/` directory. This filters out
 * same-name internal directories (e.g. `assistant/src/skills/` is the
 * catalog loader, not the top-level `skills/` directory).
 */
function findRelativeImportViolations(
  glob: string,
  targetDir: string,
): string[] {
  // Capture group 1 is the relative import path; we re-resolve it.
  const pattern = new RegExp(
    String.raw`\b(?:from|import)\s*\(?\s*["']((?:\.\./)+` +
      targetDir +
      String.raw`/[^"']*)["']`,
    "g",
  );
  const repoRoot = getRepoRoot();
  const repoTargetPrefix = `${targetDir}/`;
  const violations = new Set<string>();
  for (const relPath of new Glob(glob).scanSync({ cwd: repoRoot })) {
    const filePath = join(repoRoot, relPath);
    const content = readFileSync(filePath, "utf-8");
    for (const match of content.matchAll(pattern)) {
      const importPath = match[1]!;
      const resolved = resolve(dirname(filePath), importPath);
      const fromRoot = relative(repoRoot, resolved);
      if (fromRoot === targetDir || fromRoot.startsWith(repoTargetPrefix)) {
        violations.add(relPath);
        break;
      }
    }
  }
  return Array.from(violations).sort();
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

  test("no assistant/src/** TypeScript file imports from skills/** via relative path", () => {
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
  });
});
