import { describe, expect, test } from 'bun:test';
import {
  matchHostPattern,
  compareMatchSpecificity,
  type HostMatchKind,
} from '../tools/credentials/host-pattern-match.js';

describe('matchHostPattern', () => {
  // -- Exact matches --------------------------------------------------------

  test('exact match returns "exact"', () => {
    expect(matchHostPattern('api.fal.run', 'api.fal.run')).toBe('exact');
  });

  test('exact match is case-insensitive', () => {
    expect(matchHostPattern('API.FAL.RUN', 'api.fal.run')).toBe('exact');
    expect(matchHostPattern('api.fal.run', 'API.FAL.RUN')).toBe('exact');
  });

  // -- Wildcard matches (subdomain) ----------------------------------------

  test('*.fal.run matches api.fal.run', () => {
    expect(matchHostPattern('api.fal.run', '*.fal.run')).toBe('wildcard');
  });

  test('*.fal.run matches deep.sub.fal.run', () => {
    expect(matchHostPattern('deep.sub.fal.run', '*.fal.run')).toBe('wildcard');
  });

  test('wildcard match is case-insensitive', () => {
    expect(matchHostPattern('API.FAL.RUN', '*.fal.run')).toBe('wildcard');
  });

  // -- Wildcard does NOT match apex by default ------------------------------

  test('*.fal.run does NOT match fal.run by default', () => {
    expect(matchHostPattern('fal.run', '*.fal.run')).toBe('none');
  });

  // -- Wildcard matches apex when includeApexForWildcard = true -------------

  test('*.fal.run matches fal.run when apex inclusion enabled', () => {
    expect(matchHostPattern('fal.run', '*.fal.run', { includeApexForWildcard: true })).toBe('wildcard');
  });

  test('apex inclusion is case-insensitive', () => {
    expect(matchHostPattern('FAL.RUN', '*.fal.run', { includeApexForWildcard: true })).toBe('wildcard');
  });

  // -- Security: no partial suffix matches ----------------------------------

  test('*.fal.run does NOT match evil.fal.run.attacker.com', () => {
    expect(matchHostPattern('evil.fal.run.attacker.com', '*.fal.run')).toBe('none');
  });

  test('*.fal.run does NOT match notfal.run', () => {
    expect(matchHostPattern('notfal.run', '*.fal.run')).toBe('none');
    expect(matchHostPattern('notfal.run', '*.fal.run', { includeApexForWildcard: true })).toBe('none');
  });

  // -- No match -------------------------------------------------------------

  test('returns "none" for completely different hosts', () => {
    expect(matchHostPattern('api.openai.com', '*.fal.run')).toBe('none');
  });

  test('returns "none" for non-wildcard pattern that does not match', () => {
    expect(matchHostPattern('other.fal.run', 'api.fal.run')).toBe('none');
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

  test('same kind returns 0', () => {
    expect(compareMatchSpecificity('exact', 'exact')).toBe(0);
    expect(compareMatchSpecificity('wildcard', 'wildcard')).toBe(0);
    expect(compareMatchSpecificity('none', 'none')).toBe(0);
  });

  test('none is less specific than wildcard', () => {
    expect(compareMatchSpecificity('none', 'wildcard')).toBeGreaterThan(0);
  });

  test('wildcard is less specific than exact', () => {
    expect(compareMatchSpecificity('wildcard', 'exact')).toBeGreaterThan(0);
  });

  test('can be used to sort matches by specificity (most specific first)', () => {
    const matches: HostMatchKind[] = ['none', 'exact', 'wildcard', 'none', 'exact'];
    const sorted = [...matches].sort(compareMatchSpecificity);
    expect(sorted).toEqual(['exact', 'exact', 'wildcard', 'none', 'none']);
  });
});
