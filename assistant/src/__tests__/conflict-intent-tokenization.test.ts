import { describe, expect, test } from 'bun:test';
import { areStatementsCoherent, computeConflictRelevance, tokenizeForConflictRelevance, overlapRatio } from '../memory/conflict-intent.js';

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

describe('statement coherence (areStatementsCoherent)', () => {
  test('unrelated statements are incoherent', () => {
    expect(areStatementsCoherent(
      'The default model for the summarize CLI is google/gemini-3-flash-preview.',
      "User's favorite color is blue.",
    )).toBe(false);
  });

  test('related statements are coherent', () => {
    expect(areStatementsCoherent(
      "User's favorite color is blue.",
      "User's favorite color is green.",
    )).toBe(true);
  });

  test('topically similar preferences are coherent', () => {
    expect(areStatementsCoherent(
      'Use React for frontend work.',
      'Use Vue for frontend work.',
    )).toBe(true);
  });

  test('completely disjoint technical topics are incoherent', () => {
    expect(areStatementsCoherent(
      'Always use PostgreSQL for database storage.',
      'The preferred terminal font is JetBrains Mono.',
    )).toBe(false);
  });

  test('short technical terms (3 chars) are preserved for coherence', () => {
    // "vim" and "css" are 3 chars — should not be filtered
    expect(areStatementsCoherent(
      'Use Vim for editing.',
      'Use Emacs instead of Vim.',
    )).toBe(true);

    expect(areStatementsCoherent(
      'Use CSS grid for layouts.',
      'Use CSS flexbox for layouts.',
    )).toBe(true);

    expect(areStatementsCoherent(
      'Use npm for installs.',
      'Use npm with --legacy-peer-deps.',
    )).toBe(true);
  });

  test('short terms with no shared context are still incoherent', () => {
    // No shared tokens at all — completely different topics
    expect(areStatementsCoherent(
      'Vim is the preferred editor.',
      'CSS grid handles page layouts.',
    )).toBe(false);
  });
});
