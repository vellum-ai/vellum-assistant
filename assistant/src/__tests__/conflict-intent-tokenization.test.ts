import { describe, expect, test } from 'bun:test';
import { computeConflictRelevance } from '../memory/conflict-intent.js';

describe('tokenizeForConflictRelevance hardening', () => {
  test('excludes numeric-only tokens from relevance', () => {
    const relevance = computeConflictRelevance(
      'Check PR 5526',
      { existingStatement: 'Track PR 5525 for review.', candidateStatement: 'Track PR 5526 for review.' },
    );
    // Numeric tokens "5526" and "5525" should be excluded, so overlap is minimal
    expect(relevance).toBeLessThan(0.5);
  });

  test('excludes URL boilerplate tokens from relevance', () => {
    const relevance = computeConflictRelevance(
      'Check https://github.com/org/repo/pull/123',
      {
        existingStatement: 'Review https://github.com/org/repo/pull/456',
        candidateStatement: 'Review https://github.com/org/repo/pull/789',
      },
    );
    // URL tokens like "https", "github", "pull" should be excluded;
    // only real content tokens like "repo" remain, keeping relevance low
    expect(relevance).toBeLessThanOrEqual(0.5);
  });

  test('excludes generic tracking tokens from relevance', () => {
    const relevance = computeConflictRelevance(
      'Check issue #42',
      { existingStatement: 'Track issue #10 for review.', candidateStatement: 'Track issue #11 for review.' },
    );
    // "issue" should be excluded as a noise token
    expect(relevance).toBeLessThan(0.5);
  });

  test('still computes meaningful relevance for real content tokens', () => {
    const relevance = computeConflictRelevance(
      'Should I use React for frontend?',
      {
        existingStatement: 'Use React for frontend work.',
        candidateStatement: 'Use Vue for frontend work.',
      },
    );
    // Real content tokens like "react", "frontend" should still match
    expect(relevance).toBeGreaterThan(0);
  });
});
