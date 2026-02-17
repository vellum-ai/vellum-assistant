import { describe, test, expect } from 'bun:test';
import { sanitizeUrlForDisplay, formatPrincipalTag } from '../cli.js';

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

describe('formatPrincipalTag', () => {
  test('returns empty string for core principals', () => {
    expect(formatPrincipalTag({ principalKind: 'core' })).toBe('');
  });

  test('returns empty string when principalKind is absent', () => {
    expect(formatPrincipalTag({})).toBe('');
  });

  test('formats skill with name, version, and target', () => {
    const tag = formatPrincipalTag({
      principalKind: 'skill',
      principalId: 'weather-skill',
      principalVersion: 'sha256:abcdef1234567890fedcba',
      executionTarget: 'host',
    });
    expect(tag).toBe('[skill: weather-skill@abcdef12 \u2192 host]');
  });

  test('formats skill without version hash', () => {
    const tag = formatPrincipalTag({
      principalKind: 'skill',
      principalId: 'my-skill',
    });
    expect(tag).toBe('[skill: my-skill]');
  });

  test('formats skill with sandbox target', () => {
    const tag = formatPrincipalTag({
      principalKind: 'skill',
      principalId: 'deploy-skill',
      principalVersion: 'sha256:1111222233334444',
      executionTarget: 'sandbox',
    });
    expect(tag).toBe('[skill: deploy-skill@11112222 \u2192 sandbox]');
  });

  test('falls back to principalKind when principalId is absent', () => {
    const tag = formatPrincipalTag({
      principalKind: 'skill',
      principalVersion: 'sha256:aabbccdd',
    });
    expect(tag).toBe('[skill: skill@aabbccdd]');
  });

  test('strips non-sha256 version prefix (e.g. v1:)', () => {
    const tag = formatPrincipalTag({
      principalKind: 'skill',
      principalId: 'runtime-skill',
      principalVersion: 'v1:abcdef1234567890',
    });
    expect(tag).toBe('[skill: runtime-skill@abcdef12]');
  });
});
