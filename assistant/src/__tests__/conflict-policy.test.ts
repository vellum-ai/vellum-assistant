import { describe, expect, test } from 'bun:test';
import {
  isConflictKindEligible,
  isConflictKindPairEligible,
  isTransientTrackingStatement,
  isDurableInstructionStatement,
  isStatementConflictEligible,
} from '../memory/conflict-policy.js';

describe('conflict-policy', () => {
  const config = { conflictableKinds: ['preference', 'profile', 'constraint'] };

  describe('isConflictKindEligible', () => {
    test('returns true for eligible kind', () => {
      expect(isConflictKindEligible('preference', config)).toBe(true);
      expect(isConflictKindEligible('profile', config)).toBe(true);
      expect(isConflictKindEligible('constraint', config)).toBe(true);
    });

    test('returns false for ineligible kind', () => {
      expect(isConflictKindEligible('project', config)).toBe(false);
      expect(isConflictKindEligible('todo', config)).toBe(false);
      expect(isConflictKindEligible('fact', config)).toBe(false);
    });
  });

  describe('isConflictKindPairEligible', () => {
    test('returns true when both kinds are eligible', () => {
      expect(isConflictKindPairEligible('preference', 'profile', config)).toBe(true);
    });

    test('returns false when existing kind is ineligible', () => {
      expect(isConflictKindPairEligible('project', 'preference', config)).toBe(false);
    });

    test('returns false when candidate kind is ineligible', () => {
      expect(isConflictKindPairEligible('preference', 'todo', config)).toBe(false);
    });

    test('returns false when both kinds are ineligible', () => {
      expect(isConflictKindPairEligible('project', 'todo', config)).toBe(false);
    });
  });

  describe('isTransientTrackingStatement', () => {
    test('detects PR URLs', () => {
      expect(isTransientTrackingStatement('Track https://github.com/org/repo/pull/5526')).toBe(true);
    });

    test('detects issue/ticket references', () => {
      expect(isTransientTrackingStatement('Track PR #5526 and #5525')).toBe(true);
      expect(isTransientTrackingStatement('See issue #42 for details')).toBe(true);
      expect(isTransientTrackingStatement('Filed ticket 1234')).toBe(true);
    });

    test('detects tracking language', () => {
      expect(isTransientTrackingStatement('While we wait for CI to pass')).toBe(true);
      expect(isTransientTrackingStatement('This PR needs review')).toBe(true);
    });

    test('does not flag durable statements', () => {
      expect(isTransientTrackingStatement('Always answer with concise bullet points')).toBe(false);
      expect(isTransientTrackingStatement('User prefers dark mode')).toBe(false);
    });

    test('does not false-positive on non-PR URLs', () => {
      expect(isTransientTrackingStatement('Visit https://example.com for docs')).toBe(false);
    });
  });

  describe('isDurableInstructionStatement', () => {
    test('detects durable instruction cues', () => {
      expect(isDurableInstructionStatement('Always answer with concise bullet points')).toBe(true);
      expect(isDurableInstructionStatement('Never use semicolons in JavaScript')).toBe(true);
      expect(isDurableInstructionStatement('Use concise format for status updates')).toBe(true);
      expect(isDurableInstructionStatement('The default database is Postgres')).toBe(true);
    });

    test('rejects statements without durable cues', () => {
      expect(isDurableInstructionStatement('Check the build output')).toBe(false);
      expect(isDurableInstructionStatement('Run the migration script')).toBe(false);
    });
  });

  describe('isStatementConflictEligible', () => {
    test('rejects transient statements for any kind', () => {
      expect(isStatementConflictEligible('preference', 'Track PR #5526')).toBe(false);
      expect(isStatementConflictEligible('instruction', 'This PR needs review')).toBe(false);
    });

    test('accepts durable instruction statements', () => {
      expect(isStatementConflictEligible('instruction', 'Always use TypeScript strict mode')).toBe(true);
      expect(isStatementConflictEligible('style', 'Default to concise format')).toBe(true);
    });

    test('rejects non-durable instruction statements', () => {
      expect(isStatementConflictEligible('instruction', 'Run the build first')).toBe(false);
      expect(isStatementConflictEligible('style', 'Check the output')).toBe(false);
    });

    test('accepts non-transient statements for non-instruction kinds', () => {
      expect(isStatementConflictEligible('preference', 'User prefers dark mode')).toBe(true);
      expect(isStatementConflictEligible('fact', 'User works at Acme Corp')).toBe(true);
    });
  });
});
