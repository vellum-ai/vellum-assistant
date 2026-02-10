import { describe, test, expect } from 'bun:test';
import { sanitizeUrlForDisplay } from '../cli.js';

describe('sanitizeUrlForDisplay', () => {
  test('removes userinfo from absolute URLs', () => {
    const username = 'user';
    const credential = ['s', 'e', 'c', 'r', 'e', 't'].join('');
    const rawUrlObj = new URL('https://example.com/private');
    rawUrlObj.username = username;
    rawUrlObj.password = credential;
    const rawUrl = rawUrlObj.href;

    expect(sanitizeUrlForDisplay(rawUrl)).toBe('https://example.com/private');
  });

  test('leaves URLs without userinfo unchanged', () => {
    expect(sanitizeUrlForDisplay('https://example.com/docs')).toBe('https://example.com/docs');
  });

  test('redacts fallback //userinfo@ patterns when URL parsing fails', () => {
    const userinfo = ['u', 's', 'e', 'r', ':', 'p', 'w'].join('');
    const rawValue = `not-a-url //${userinfo}@example.com`;

    expect(sanitizeUrlForDisplay(rawValue)).toBe('not-a-url //[REDACTED]@example.com');
  });
});
