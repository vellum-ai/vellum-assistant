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

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

const repoRoot = resolve(__dirname, '..', '..', '..');

describe('isTrusted guard', () => {
  test('isTrusted property must not exist in production ActorContext usage', () => {
    // Search for `isTrusted` used as a property (e.g., `.isTrusted`, `isTrusted:`,
    // `isTrusted =`) in production TypeScript files, excluding tests, node_modules,
    // and the allowed trust-class variable pattern.
    const result = execSync(
      [
        'grep -rn "isTrusted" assistant/src/ --include="*.ts"',
        'grep -v "__tests__"',
        'grep -v "node_modules"',
        // Allow `isTrustedActor`, `isTrustedContact`, `isTrustedTrustClass` —
        // these are local variable names checking trust class, not the legacy
        // ActorContext property.
        'grep -v "isTrustedActor\\|isTrustedContact\\|isTrustedTrustClass"',
        'true',
      ].join(' | '),
      { encoding: 'utf-8', cwd: repoRoot },
    );

    if (result.trim()) {
      throw new Error(
        'Found `isTrusted` references in production code. Authorization must use ' +
        '`guardianPrincipalId` matching instead. Offending lines:\n' +
        result.trim(),
      );
    }
  });

  test('ActorContext interface must not declare isTrusted field', () => {
    // Verify the ActorContext type definition does not include isTrusted
    const result = execSync(
      [
        'grep -n "isTrusted" assistant/src/approvals/guardian-request-resolvers.ts',
        'true',
      ].join(' || '),
      { encoding: 'utf-8', cwd: repoRoot },
    );

    expect(result.trim()).toBe('');
  });
});
