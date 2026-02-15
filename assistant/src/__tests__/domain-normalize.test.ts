import { describe, test, expect } from 'bun:test';
import { normalizeDomain } from '../tools/network/domain-normalize.js';

describe('normalizeDomain', () => {
  // ── Basic hostname parsing ──────────────────────────────────────────

  test('parses simple hostname', () => {
    const result = normalizeDomain('example.com');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('example.com');
    expect(result!.registrableDomain).toBe('example.com');
  });

  test('parses subdomain', () => {
    const result = normalizeDomain('login.example.com');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('login.example.com');
    expect(result!.registrableDomain).toBe('example.com');
  });

  test('parses deep subdomain', () => {
    const result = normalizeDomain('foo.bar.example.co.uk');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('foo.bar.example.co.uk');
    expect(result!.registrableDomain).toBe('example.co.uk');
  });

  // ── URL extraction ──────────────────────────────────────────────────

  test('extracts hostname from full URL', () => {
    const result = normalizeDomain('https://login.example.com/path?q=1');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('login.example.com');
    expect(result!.registrableDomain).toBe('example.com');
  });

  test('extracts hostname from URL with port', () => {
    const result = normalizeDomain('https://example.com:8443/api');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('example.com');
  });

  test('strips port from bare hostname', () => {
    const result = normalizeDomain('example.com:8080');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('example.com');
    expect(result!.registrableDomain).toBe('example.com');
  });

  // ── Normalization ───────────────────────────────────────────────────

  test('lowercases hostname', () => {
    const result = normalizeDomain('Login.EXAMPLE.Com');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('login.example.com');
    expect(result!.registrableDomain).toBe('example.com');
  });

  test('strips trailing dot', () => {
    const result = normalizeDomain('example.com.');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('example.com');
    expect(result!.registrableDomain).toBe('example.com');
  });

  // ── Punycode / IDN ──────────────────────────────────────────────────

  test('handles punycode domain', () => {
    const result = normalizeDomain('xn--nxasmq6b.example.com');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('xn--nxasmq6b.example.com');
    expect(result!.registrableDomain).toBe('example.com');
  });

  // ── Rejection cases ─────────────────────────────────────────────────

  test('returns null for IPv4 address', () => {
    expect(normalizeDomain('192.168.1.1')).toBeNull();
  });

  test('returns null for IPv6 address', () => {
    expect(normalizeDomain('[::1]')).toBeNull();
    expect(normalizeDomain('::1')).toBeNull();
  });

  test('returns null for localhost', () => {
    expect(normalizeDomain('localhost')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(normalizeDomain('')).toBeNull();
  });

  test('returns null for null-like input', () => {
    expect(normalizeDomain(null as unknown as string)).toBeNull();
    expect(normalizeDomain(undefined as unknown as string)).toBeNull();
  });

  // ── Co.uk / multi-part TLD ──────────────────────────────────────────

  test('handles co.uk correctly', () => {
    const result = normalizeDomain('www.bbc.co.uk');
    expect(result).not.toBeNull();
    expect(result!.registrableDomain).toBe('bbc.co.uk');
  });

  test('handles com.au correctly', () => {
    const result = normalizeDomain('shop.example.com.au');
    expect(result).not.toBeNull();
    expect(result!.registrableDomain).toBe('example.com.au');
  });
});
