import { describe, expect, test } from 'bun:test';

import {
  compareMatchSpecificity,
  type HostMatchKind,
  matchHostPattern,
} from '../host-pattern-match.js';

describe('matchHostPattern', () => {
  // -- Exact matches --------------------------------------------------------

  test('exact match returns "exact"', () => {
    expect(matchHostPattern('api.fal.ai', 'api.fal.ai')).toBe('exact');
  });

  test('exact match is case-insensitive', () => {
    expect(matchHostPattern('API.FAL.AI', 'api.fal.ai')).toBe('exact');
    expect(matchHostPattern('api.fal.ai', 'API.FAL.AI')).toBe('exact');
    expect(matchHostPattern('Api.Fal.Ai', 'api.fal.ai')).toBe('exact');
  });

  // -- Wildcard matches -----------------------------------------------------

  test('wildcard pattern matches subdomain', () => {
    expect(matchHostPattern('api.fal.ai', '*.fal.ai')).toBe('wildcard');
  });

  test('wildcard pattern matches deeply nested subdomain', () => {
    expect(matchHostPattern('deep.sub.fal.ai', '*.fal.ai')).toBe('wildcard');
  });

  test('wildcard match is case-insensitive', () => {
    expect(matchHostPattern('API.FAL.AI', '*.fal.ai')).toBe('wildcard');
    expect(matchHostPattern('api.fal.ai', '*.FAL.AI')).toBe('wildcard');
  });

  test('wildcard pattern does not match apex by default', () => {
    expect(matchHostPattern('fal.ai', '*.fal.ai')).toBe('none');
  });

  test('wildcard pattern matches apex with includeApexForWildcard', () => {
    expect(
      matchHostPattern('fal.ai', '*.fal.ai', { includeApexForWildcard: true }),
    ).toBe('wildcard');
  });

  test('wildcard apex match is case-insensitive', () => {
    expect(
      matchHostPattern('FAL.AI', '*.fal.ai', { includeApexForWildcard: true }),
    ).toBe('wildcard');
  });

  // -- No match -------------------------------------------------------------

  test('returns "none" for non-matching hostname', () => {
    expect(matchHostPattern('api.openai.com', '*.fal.ai')).toBe('none');
  });

  test('returns "none" for partial suffix match that is not a subdomain', () => {
    // "notfal.ai" ends with "fal.ai" but is not ".fal.ai"
    expect(matchHostPattern('notfal.ai', '*.fal.ai')).toBe('none');
  });

  test('returns "none" for completely different domain', () => {
    expect(matchHostPattern('example.com', 'api.fal.ai')).toBe('none');
  });

  test('returns "none" for empty pattern', () => {
    expect(matchHostPattern('api.fal.ai', '')).toBe('none');
  });

  test('returns "none" for non-wildcard non-exact pattern', () => {
    expect(matchHostPattern('api.fal.ai', 'fal.ai')).toBe('none');
  });

  // -- Edge cases -----------------------------------------------------------

  test('single-label hostname with exact pattern', () => {
    expect(matchHostPattern('localhost', 'localhost')).toBe('exact');
  });

  test('wildcard pattern with single-label suffix', () => {
    expect(matchHostPattern('sub.localhost', '*.localhost')).toBe('wildcard');
  });

  test('pattern starting with *. but host is just the dot-suffix', () => {
    // "*.com" should not match "com" without apex inclusion
    expect(matchHostPattern('com', '*.com')).toBe('none');
    // But it should with apex inclusion
    expect(
      matchHostPattern('com', '*.com', { includeApexForWildcard: true }),
    ).toBe('wildcard');
  });

  test('includeApexForWildcard defaults to false', () => {
    expect(matchHostPattern('fal.ai', '*.fal.ai')).toBe('none');
    expect(matchHostPattern('fal.ai', '*.fal.ai', {})).toBe('none');
    expect(
      matchHostPattern('fal.ai', '*.fal.ai', { includeApexForWildcard: false }),
    ).toBe('none');
  });

  test('fal.run with *.fal.run pattern and apex inclusion', () => {
    expect(
      matchHostPattern('fal.run', '*.fal.run', { includeApexForWildcard: true }),
    ).toBe('wildcard');
  });
});

describe('compareMatchSpecificity', () => {
  test('exact is more specific than wildcard', () => {
    expect(compareMatchSpecificity('exact', 'wildcard')).toBeLessThan(0);
  });

  test('wildcard is more specific than none', () => {
    expect(compareMatchSpecificity('wildcard', 'none')).toBeLessThan(0);
  });

  test('exact is more specific than none', () => {
    expect(compareMatchSpecificity('exact', 'none')).toBeLessThan(0);
  });

  test('none is less specific than exact', () => {
    expect(compareMatchSpecificity('none', 'exact')).toBeGreaterThan(0);
  });

  test('none is less specific than wildcard', () => {
    expect(compareMatchSpecificity('none', 'wildcard')).toBeGreaterThan(0);
  });

  test('wildcard is less specific than exact', () => {
    expect(compareMatchSpecificity('wildcard', 'exact')).toBeGreaterThan(0);
  });

  test('equal specificities return zero', () => {
    const kinds: HostMatchKind[] = ['exact', 'wildcard', 'none'];
    for (const k of kinds) {
      expect(compareMatchSpecificity(k, k)).toBe(0);
    }
  });
});
