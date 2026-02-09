import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { findMatch, findAllMatches } from '../tools/filesystem/fuzzy-match.js';

describe('fuzzy-match property-based tests', () => {
  test('exact match always has similarity 1', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        (s) => {
          const result = findMatch(s, s);
          expect(result).not.toBeNull();
          expect(result!.similarity).toBe(1);
          expect(result!.method).toBe('exact');
        }
      ),
      { numRuns: 200 }
    );
  });

  test('similarity score is always in [0, 1] range', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 200 }),
        (content, target) => {
          const result = findMatch(content, target);
          if (result !== null) {
            expect(result.similarity).toBeGreaterThanOrEqual(0);
            expect(result.similarity).toBeLessThanOrEqual(1);
          }
        }
      ),
      { numRuns: 500 }
    );
  });

  test('empty target always returns null', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        (content) => {
          const result = findMatch(content, '');
          expect(result).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  test('findAllMatches with empty target returns empty array', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        (content) => {
          const results = findAllMatches(content, '');
          expect(results).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('substring of content always produces a match', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 3, maxLength: 200 }),
        (content) => {
          // Pick a non-empty substring from the content
          if (content.length < 2) return;
          const start = 0;
          const end = Math.min(content.length, 3);
          const target = content.slice(start, end);
          if (target.length === 0) return;

          const result = findMatch(content, target);
          expect(result).not.toBeNull();
          expect(result!.similarity).toBeGreaterThan(0);
        }
      ),
      { numRuns: 300 }
    );
  });

  test('exact match start and end indices are correct', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        (prefix, target, suffix) => {
          // Avoid cases where target appears in prefix or suffix
          if (prefix.includes(target) || suffix.includes(target)) return;

          const content = prefix + target + suffix;
          // Ensure target's first occurrence is exactly at the inserted position,
          // not at an earlier overlapping boundary (e.g. prefix='ab', target='aba')
          fc.pre(content.indexOf(target) === prefix.length);
          const result = findMatch(content, target);
          expect(result).not.toBeNull();
          expect(result!.method).toBe('exact');
          expect(result!.start).toBe(prefix.length);
          expect(result!.end).toBe(prefix.length + target.length);
          expect(result!.matched).toBe(target);
        }
      ),
      { numRuns: 300 }
    );
  });

  test('findAllMatches returns at least as many exact matches as occurrences', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.integer({ min: 1, max: 5 }),
        (word, repeats) => {
          if (word.length === 0) return;
          // Build content with the word repeated, separated by a delimiter
          const separator = '|||';
          if (word.includes(separator)) return;
          const content = Array(repeats).fill(word).join(separator);

          const results = findAllMatches(content, word);
          expect(results.length).toBeGreaterThanOrEqual(repeats);
        }
      ),
      { numRuns: 200 }
    );
  });

  test('matched text is always a substring of content for exact matches', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (content, target) => {
          const result = findMatch(content, target);
          if (result !== null && result.method === 'exact') {
            expect(content.includes(result.matched)).toBe(true);
            expect(content.slice(result.start, result.end)).toBe(result.matched);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  test('findMatch result is consistent with findAllMatches', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (content, target) => {
          const single = findMatch(content, target);
          const all = findAllMatches(content, target);

          if (single === null) {
            expect(all.length).toBe(0);
          } else {
            expect(all.length).toBeGreaterThanOrEqual(1);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  test('similarity of 1 implies exact or whitespace method', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        (content, target) => {
          const result = findMatch(content, target);
          if (result !== null && result.similarity === 1) {
            expect(['exact', 'whitespace']).toContain(result.method);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  test('start is always less than or equal to end', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        (content, target) => {
          const result = findMatch(content, target);
          if (result !== null) {
            expect(result.start).toBeLessThanOrEqual(result.end);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  test('multiline exact self-match works', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 10 }),
        (lines) => {
          const content = lines.join('\n');
          if (content.length === 0) return;

          const result = findMatch(content, content);
          expect(result).not.toBeNull();
          expect(result!.similarity).toBe(1);
        }
      ),
      { numRuns: 200 }
    );
  });
});
