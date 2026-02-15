import { describe, test, expect } from 'bun:test';
import { isDomainAllowed } from '../tools/credentials/domain-policy.js';

describe('isDomainAllowed', () => {
  // ── Exact host match ────────────────────────────────────────────────

  test('allows exact hostname match', () => {
    expect(isDomainAllowed('example.com', ['example.com'])).toBe(true);
  });

  test('allows exact hostname match (case insensitive)', () => {
    expect(isDomainAllowed('Example.COM', ['example.com'])).toBe(true);
  });

  // ── Registrable-domain + subdomain ──────────────────────────────────

  test('allows subdomain when registrable domain matches', () => {
    expect(isDomainAllowed('login.example.com', ['example.com'])).toBe(true);
  });

  test('allows deep subdomain when registrable domain matches', () => {
    expect(isDomainAllowed('a.b.c.example.com', ['example.com'])).toBe(true);
  });

  test('allows subdomain of co.uk domain', () => {
    expect(isDomainAllowed('login.bbc.co.uk', ['bbc.co.uk'])).toBe(true);
  });

  // ── Deny cases ──────────────────────────────────────────────────────

  test('denies unrelated domain', () => {
    expect(isDomainAllowed('evil.com', ['example.com'])).toBe(false);
  });

  test('denies domain that looks similar but differs', () => {
    expect(isDomainAllowed('notexample.com', ['example.com'])).toBe(false);
  });

  test('denies different TLD', () => {
    expect(isDomainAllowed('example.org', ['example.com'])).toBe(false);
  });

  test('denies when allowed list is empty', () => {
    expect(isDomainAllowed('example.com', [])).toBe(false);
  });

  test('denies when allowed list is undefined-like', () => {
    expect(isDomainAllowed('example.com', undefined as unknown as string[])).toBe(false);
  });

  test('denies when request host is empty', () => {
    expect(isDomainAllowed('', ['example.com'])).toBe(false);
  });

  test('denies when request host is invalid', () => {
    expect(isDomainAllowed('not a valid host!!!', ['example.com'])).toBe(false);
  });

  test('denies malformed host even when same string is in allowed list', () => {
    expect(isDomainAllowed('not a valid host!!!', ['not a valid host!!!'])).toBe(false);
  });

  test('denies IP addresses', () => {
    expect(isDomainAllowed('192.168.1.1', ['192.168.1.1'])).toBe(false);
  });

  test('denies localhost', () => {
    expect(isDomainAllowed('localhost', ['localhost'])).toBe(false);
  });

  // ── URL extraction ──────────────────────────────────────────────────

  test('extracts hostname from full URL', () => {
    expect(isDomainAllowed('https://login.example.com/path', ['example.com'])).toBe(true);
  });

  test('denies URL with wrong domain', () => {
    expect(isDomainAllowed('https://evil.com/path', ['example.com'])).toBe(false);
  });

  // ── Subdomain in allowed list ──────────────────────────────────────

  test('allows exact subdomain match when subdomain is in allowed list', () => {
    expect(isDomainAllowed('login.example.com', ['login.example.com'])).toBe(true);
  });

  test('denies different subdomain when only specific subdomain is allowed', () => {
    // When allowed is a subdomain (not the registrable domain itself),
    // only exact matches should work
    expect(isDomainAllowed('other.example.com', ['login.example.com'])).toBe(false);
  });

  // ── Multiple allowed domains ────────────────────────────────────────

  test('matches against any domain in the allowed list', () => {
    expect(isDomainAllowed('login.github.com', ['example.com', 'github.com'])).toBe(true);
  });

  test('denies when none of the allowed domains match', () => {
    expect(isDomainAllowed('evil.com', ['example.com', 'github.com'])).toBe(false);
  });
});
