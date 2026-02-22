import { describe, expect, test } from 'bun:test';
import { computeConflictRelevance, tokenizeForConflictRelevance, overlapRatio } from '../memory/conflict-intent.js';

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

  test('URL-embedded tracking tokens are stripped, standalone usage preserved', () => {
    // URLs containing "issue", "pull", etc. are stripped entirely before tokenizing
    const urlRelevance = computeConflictRelevance(
      'Check https://github.com/org/repo/issues/42',
      {
        existingStatement: 'Review https://github.com/org/repo/issues/10',
        candidateStatement: 'Review https://github.com/org/repo/issues/11',
      },
    );
    expect(urlRelevance).toBeLessThanOrEqual(0.5);

    // Standalone "issue" is preserved as a meaningful token
    const standaloneRelevance = computeConflictRelevance(
      'should I file an issue?',
      {
        existingStatement: 'File an issue when bugs are found.',
        candidateStatement: 'Skip filing an issue for minor bugs.',
      },
    );
    expect(standaloneRelevance).toBeGreaterThan(0);
  });

  test('strips scheme-less bare domain URLs from relevance', () => {
    const relevance = computeConflictRelevance(
      'Check github.com/org/repo/pull/123',
      {
        existingStatement: 'Review gitlab.com/org/repo/issues/456',
        candidateStatement: 'Review github.com/org/repo/pull/789',
      },
    );
    // Bare URLs should be stripped entirely; tokens like "pull", "issues"
    // embedded in paths must not contribute to overlap
    expect(relevance).toBeLessThanOrEqual(0.5);
  });

  test('preserves dotted identifiers that look like file paths', () => {
    const relevance = computeConflictRelevance(
      'Use index.ts/runtime parser',
      {
        existingStatement: 'Keep index.ts/runtime approach.',
        candidateStatement: 'Switch to config.ts/runtime approach.',
      },
    );
    // File-like identifiers should NOT be stripped as URLs
    expect(relevance).toBeGreaterThan(0);
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

describe('statement coherence (overlap between conflict statements)', () => {
  test('unrelated statements have zero overlap', () => {
    const existingTokens = tokenizeForConflictRelevance(
      'The default model for the summarize CLI is google/gemini-3-flash-preview.',
    );
    const candidateTokens = tokenizeForConflictRelevance(
      "User's favorite color is blue.",
    );
    expect(overlapRatio(existingTokens, candidateTokens)).toBe(0);
  });

  test('related statements have non-zero overlap', () => {
    const existingTokens = tokenizeForConflictRelevance(
      "User's favorite color is blue.",
    );
    const candidateTokens = tokenizeForConflictRelevance(
      "User's favorite color is green.",
    );
    // Should share tokens like "favorite", "color"
    expect(overlapRatio(existingTokens, candidateTokens)).toBeGreaterThan(0);
  });

  test('topically similar preferences have overlap', () => {
    const existingTokens = tokenizeForConflictRelevance(
      'Use React for frontend work.',
    );
    const candidateTokens = tokenizeForConflictRelevance(
      'Use Vue for frontend work.',
    );
    // Should share "frontend", "work"
    expect(overlapRatio(existingTokens, candidateTokens)).toBeGreaterThan(0);
  });

  test('completely disjoint technical topics have zero overlap', () => {
    const existingTokens = tokenizeForConflictRelevance(
      'Always use PostgreSQL for database storage.',
    );
    const candidateTokens = tokenizeForConflictRelevance(
      'The preferred terminal font is JetBrains Mono.',
    );
    expect(overlapRatio(existingTokens, candidateTokens)).toBe(0);
  });
});
