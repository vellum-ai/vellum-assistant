import { describe, test, expect } from 'bun:test';
import { normalizeDomain } from '../domain-normalize.js';

describe('normalizeDomain', () => {
  // ---- Valid inputs -------------------------------------------------------

  test('parses bare hostname', () => {
    const result = normalizeDomain('example.com');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('example.com');
    expect(result!.registrableDomain).toBe('example.com');
  });

  test('parses subdomain hostname', () => {
    const result = normalizeDomain('foo.bar.example.com');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('foo.bar.example.com');
    expect(result!.registrableDomain).toBe('example.com');
  });

  test('parses multi-level TLD', () => {
    const result = normalizeDomain('foo.bar.example.co.uk');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('foo.bar.example.co.uk');
    expect(result!.registrableDomain).toBe('example.co.uk');
  });

  test('extracts hostname from full URL', () => {
    const result = normalizeDomain('https://api.example.com/path?q=1');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('api.example.com');
    expect(result!.registrableDomain).toBe('example.com');
  });

  test('lowercases hostname', () => {
    const result = normalizeDomain('EXAMPLE.COM');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('example.com');
  });

  test('strips trailing dot', () => {
    const result = normalizeDomain('example.com.');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('example.com');
    expect(result!.registrableDomain).toBe('example.com');
  });

  test('strips trailing port from bare hostname', () => {
    const result = normalizeDomain('example.com:8080');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('example.com');
    expect(result!.registrableDomain).toBe('example.com');
  });

  // ---- Invalid inputs -----------------------------------------------------

  test('returns null for empty string', () => {
    expect(normalizeDomain('')).toBeNull();
  });

  test('returns null for non-string input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeDomain(null as any)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeDomain(undefined as any)).toBeNull();
  });

  test('returns null for IPv4 address', () => {
    expect(normalizeDomain('192.168.1.1')).toBeNull();
    expect(normalizeDomain('10.0.0.1')).toBeNull();
  });

  test('returns null for bracketed IPv6 address', () => {
    expect(normalizeDomain('[::1]')).toBeNull();
    expect(normalizeDomain('[2001:db8::1]')).toBeNull();
  });

  test('returns null for bare IPv6 (colon detection)', () => {
    expect(normalizeDomain('::1')).toBeNull();
  });

  test('returns null for localhost', () => {
    expect(normalizeDomain('localhost')).toBeNull();
  });

  test('returns null for malformed hostnames', () => {
    // Leading hyphen
    expect(normalizeDomain('-example.com')).toBeNull();
    // Trailing hyphen
    expect(normalizeDomain('example-.com')).toBeNull();
    // Consecutive dots
    expect(normalizeDomain('example..com')).toBeNull();
  });

  test('returns null for empty hostname after stripping', () => {
    expect(normalizeDomain('.')).toBeNull();
  });
});
