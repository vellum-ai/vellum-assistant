import { describe, expect, test } from 'bun:test';
import { extractLeadingToken, isPathLikeSlashToken, isValidSlashSkillId, parseSlashCandidate } from '../skills/slash-commands.js';

describe('extractLeadingToken', () => {
  test('returns null for empty string', () => {
    expect(extractLeadingToken('')).toBeNull();
  });

  test('returns null for whitespace-only string', () => {
    expect(extractLeadingToken('   ')).toBeNull();
    expect(extractLeadingToken('\t\n')).toBeNull();
  });

  test('returns the first token for normal text', () => {
    expect(extractLeadingToken('hello world')).toBe('hello');
  });

  test('returns the first token with leading whitespace', () => {
    expect(extractLeadingToken('   hello world')).toBe('hello');
  });

  test('returns slash token', () => {
    expect(extractLeadingToken('/start-the-day')).toBe('/start-the-day');
  });

  test('returns slash token with trailing args', () => {
    expect(extractLeadingToken('   /start-the-day   foo')).toBe('/start-the-day');
  });
});

describe('parseSlashCandidate', () => {
  test('returns none for empty input', () => {
    expect(parseSlashCandidate('')).toEqual({ kind: 'none' });
  });

  test('returns none for whitespace-only input', () => {
    expect(parseSlashCandidate('   ')).toEqual({ kind: 'none' });
  });

  test('returns none for normal text', () => {
    expect(parseSlashCandidate('hello world')).toEqual({ kind: 'none' });
  });

  test('returns candidate for /start-the-day', () => {
    expect(parseSlashCandidate('/start-the-day')).toEqual({
      kind: 'candidate',
      token: '/start-the-day',
    });
  });

  test('returns candidate for /start-the-day with leading whitespace and args', () => {
    expect(parseSlashCandidate('   /start-the-day   foo')).toEqual({
      kind: 'candidate',
      token: '/start-the-day',
    });
  });

  test('returns none for path-like /tmp/file', () => {
    expect(parseSlashCandidate('/tmp/file')).toEqual({ kind: 'none' });
  });

  test('returns none for path-like /Users/sidd', () => {
    expect(parseSlashCandidate('/Users/sidd')).toEqual({ kind: 'none' });
  });

  test('returns none for path-like /foo/bar', () => {
    expect(parseSlashCandidate('/foo/bar')).toEqual({ kind: 'none' });
  });

  test('returns none for /.hidden (invalid ID)', () => {
    expect(parseSlashCandidate('/.hidden')).toEqual({ kind: 'none' });
  });

  test('returns none for /... (invalid ID)', () => {
    expect(parseSlashCandidate('/...')).toEqual({ kind: 'none' });
  });

  test('returns candidate for valid /start_the.day-1', () => {
    expect(parseSlashCandidate('/start_the.day-1')).toEqual({
      kind: 'candidate',
      token: '/start_the.day-1',
    });
  });
});

describe('isValidSlashSkillId', () => {
  test('accepts alphanumeric with dots, hyphens, underscores', () => {
    expect(isValidSlashSkillId('start-the-day')).toBe(true);
    expect(isValidSlashSkillId('my_skill.v2')).toBe(true);
    expect(isValidSlashSkillId('A1')).toBe(true);
  });

  test('rejects empty string', () => {
    expect(isValidSlashSkillId('')).toBe(false);
  });

  test('rejects strings with dots only', () => {
    expect(isValidSlashSkillId('...')).toBe(false);
  });

  test('rejects strings starting with dot', () => {
    expect(isValidSlashSkillId('.hidden')).toBe(false);
  });

  test('rejects strings with slashes', () => {
    expect(isValidSlashSkillId('foo/bar')).toBe(false);
  });
});

describe('isPathLikeSlashToken', () => {
  test('detects paths with multiple slashes', () => {
    expect(isPathLikeSlashToken('/tmp/file')).toBe(true);
    expect(isPathLikeSlashToken('/Users/sidd')).toBe(true);
  });

  test('single leading slash is not path-like', () => {
    expect(isPathLikeSlashToken('/start-the-day')).toBe(false);
  });
});
