/**
 * Guard test: `isTrusted` must not appear in production code.
 *
 * The authorization model was migrated from a boolean `isTrusted` flag to
 * principal-based authorization (`guardianPrincipalId` matching). This guard
 * ensures the legacy pattern is never reintroduced in production source files.
 *
 * The invariant: `actor.guardianPrincipalId === request.guardianPrincipalId`
 * (with cross-channel fallback via the vellum canonical principal).
 *
 * Allowed exceptions:
 *   - Variable names like `isTrustedActor` or `isTrustedContact` that refer
 *     to trust-class checks (e.g. `trustClass === 'guardian'`), NOT to a
 *     boolean `isTrusted` property on ActorContext.
 *   - Test files (__tests__/) — may reference `isTrusted` in test descriptions
 *     or comments about the migration.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = resolve(__dirname, "..", "..", "..");

describe("isTrusted guard", () => {
  test("isTrusted property must not exist in production ActorContext usage", () => {
    // Search for `isTrusted` used as a property (e.g., `.isTrusted`, `isTrusted:`,
    // `isTrusted =`) in production TypeScript files, excluding tests, node_modules,
    // and the allowed trust-class variable pattern.
    const raw = execSync(
      [
        'grep -rn "isTrusted" assistant/src/ --include="*.ts"',
        'grep -v "__tests__"',
        'grep -v "node_modules"',
      ].join(" | ") + " || true",
      { encoding: "utf-8", cwd: repoRoot },
    );

    // Filter in JS: strip allowed token names from each line, then check if
    // `isTrusted` still appears. This avoids the grep -v approach which could
    // mask forbidden usage on lines that also contain allowed tokens.
    const ALLOWED_TOKENS = [
      "isTrustedActor",
      "isTrustedContact",
      "isTrustedTrustClass",
    ];
    const offending = raw
      .trim()
      .split("\n")
      .filter((line) => {
        if (!line) return false;
        let stripped = line;
        for (const token of ALLOWED_TOKENS) {
          stripped = stripped.replaceAll(token, "");
        }
        return stripped.includes("isTrusted");
      });

    if (offending.length > 0) {
      throw new Error(
        "Found `isTrusted` references in production code. Authorization must use " +
          "`guardianPrincipalId` matching instead. Offending lines:\n" +
          offending.join("\n"),
      );
    }
  });

  test("ActorContext interface must not declare isTrusted field", () => {
    // Verify the ActorContext type definition does not include isTrusted
    const result = execSync(
      [
        'grep -n "isTrusted" assistant/src/approvals/guardian-request-resolvers.ts',
        "true",
      ].join(" || "),
      { encoding: "utf-8", cwd: repoRoot },
    );

    expect(result.trim()).toBe("");
  });
});
