import { describe, expect, test } from 'bun:test';
import { isConflictKindEligible, isConflictKindPairEligible } from '../memory/conflict-policy.js';

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
});
