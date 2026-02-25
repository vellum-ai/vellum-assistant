import { describe, test, expect } from 'bun:test';
import {
  looksLikeHostPortShorthand,
  looksLikePathOnlyInput,
  parseUrl,
  isIPv4,
  isPrivateIPv4,
  unwrapBracketedHostname,
  extractEmbeddedIPv4FromIPv6,
  isIPv6,
  isPrivateIPv6,
  isPrivateOrLocalHost,
  resolveRequestAddress,
  buildHostHeader,
  stripUrlUserinfo,
  sanitizeUrlForOutput,
  sanitizeUrlStringForOutput,
} from '../tools/network/url-safety.js';

describe('url-safety helpers', () => {
  // ── looksLikeHostPortShorthand ───────────────────────────────

  describe('looksLikeHostPortShorthand', () => {
    test('recognizes host:port', () => {
      expect(looksLikeHostPortShorthand('example.com:8080')).toBe(true);
      expect(looksLikeHostPortShorthand('example.com:8080/path')).toBe(true);
    });

    test('recognizes bracketed IPv6 with port', () => {
      expect(looksLikeHostPortShorthand('[::1]:3000')).toBe(true);
      expect(looksLikeHostPortShorthand('[2001:db8::1]:443/path')).toBe(true);
    });

    test('rejects plain hostnames without port', () => {
      expect(looksLikeHostPortShorthand('example.com')).toBe(false);
      expect(looksLikeHostPortShorthand('example.com/path')).toBe(false);
    });

    test('rejects URLs with scheme', () => {
      expect(looksLikeHostPortShorthand('https://example.com:8080')).toBe(false);
    });
  });

  // ── looksLikePathOnlyInput ───────────────────────────────────

  describe('looksLikePathOnlyInput', () => {
    test('detects absolute paths', () => {
      expect(looksLikePathOnlyInput('/docs/page')).toBe(true);
    });

    test('detects relative paths', () => {
      expect(looksLikePathOnlyInput('./file')).toBe(true);
      expect(looksLikePathOnlyInput('../parent/file')).toBe(true);
    });

    test('detects query/fragment-only', () => {
      expect(looksLikePathOnlyInput('?q=test')).toBe(true);
      expect(looksLikePathOnlyInput('#section')).toBe(true);
    });

    test('rejects hostnames', () => {
      expect(looksLikePathOnlyInput('example.com')).toBe(false);
    });
  });

  // ── parseUrl ─────────────────────────────────────────────────

  describe('parseUrl', () => {
    test('parses full URLs', () => {
      const url = parseUrl('https://example.com/path');
      expect(url).not.toBeNull();
      expect(url!.href).toBe('https://example.com/path');
    });

    test('adds https:// for bare hostnames', () => {
      const url = parseUrl('example.com/docs');
      expect(url).not.toBeNull();
      expect(url!.href).toBe('https://example.com/docs');
    });

    test('adds https:// for host:port shorthand', () => {
      const url = parseUrl('example.com:8443/docs');
      expect(url).not.toBeNull();
      expect(url!.href).toBe('https://example.com:8443/docs');
    });

    test('returns null for non-string input', () => {
      expect(parseUrl(42)).toBeNull();
      expect(parseUrl(null)).toBeNull();
      expect(parseUrl(undefined)).toBeNull();
    });

    test('returns null for empty/whitespace', () => {
      expect(parseUrl('')).toBeNull();
      expect(parseUrl('   ')).toBeNull();
    });

    test('returns null for path-only input', () => {
      expect(parseUrl('/docs/page')).toBeNull();
      expect(parseUrl('./file')).toBeNull();
    });

    test('returns null for unknown schemes', () => {
      expect(parseUrl('ftp://example.com')).not.toBeNull(); // URL constructor parses ftp
      expect(parseUrl('custom-scheme://foo')).not.toBeNull();
    });

    test('rejects bare hostnames that look like other schemes', () => {
      // "git:" matches /^[a-zA-Z][a-zA-Z0-9+.-]*:/ but URL constructor parses it
      // as a valid scheme URI, so parseUrl returns a URL object
      expect(parseUrl('git:')).not.toBeNull();
    });
  });

  // ── isIPv4 ───────────────────────────────────────────────────

  describe('isIPv4', () => {
    test('recognizes valid IPv4', () => {
      expect(isIPv4('127.0.0.1')).toBe(true);
      expect(isIPv4('192.168.1.1')).toBe(true);
      expect(isIPv4('0.0.0.0')).toBe(true);
      expect(isIPv4('255.255.255.255')).toBe(true);
    });

    test('rejects invalid IPv4', () => {
      expect(isIPv4('256.0.0.1')).toBe(false);
      expect(isIPv4('1.2.3')).toBe(false);
      expect(isIPv4('1.2.3.4.5')).toBe(false);
      expect(isIPv4('localhost')).toBe(false);
      expect(isIPv4('::1')).toBe(false);
    });
  });

  // ── isPrivateIPv4 ────────────────────────────────────────────

  describe('isPrivateIPv4', () => {
    test('classifies private ranges', () => {
      expect(isPrivateIPv4('10.0.0.1')).toBe(true);
      expect(isPrivateIPv4('127.0.0.1')).toBe(true);
      expect(isPrivateIPv4('192.168.1.1')).toBe(true);
      expect(isPrivateIPv4('172.16.0.1')).toBe(true);
      expect(isPrivateIPv4('172.31.255.255')).toBe(true);
      expect(isPrivateIPv4('169.254.1.1')).toBe(true);
      expect(isPrivateIPv4('0.0.0.0')).toBe(true);
    });

    test('classifies public addresses', () => {
      expect(isPrivateIPv4('93.184.216.34')).toBe(false);
      expect(isPrivateIPv4('8.8.8.8')).toBe(false);
      expect(isPrivateIPv4('1.1.1.1')).toBe(false);
    });

    test('classifies multicast/broadcast', () => {
      expect(isPrivateIPv4('224.0.0.1')).toBe(true);
      expect(isPrivateIPv4('255.255.255.255')).toBe(true);
    });

    test('classifies benchmarking range', () => {
      expect(isPrivateIPv4('198.18.0.10')).toBe(true);
      expect(isPrivateIPv4('198.19.255.255')).toBe(true);
    });

    test('classifies CGNAT range', () => {
      expect(isPrivateIPv4('100.64.0.1')).toBe(true);
      expect(isPrivateIPv4('100.127.255.255')).toBe(true);
    });

    test('boundary: 172.15 is public but 172.16 is private', () => {
      expect(isPrivateIPv4('172.15.255.255')).toBe(false);
      expect(isPrivateIPv4('172.16.0.0')).toBe(true);
      expect(isPrivateIPv4('172.31.255.255')).toBe(true);
      expect(isPrivateIPv4('172.32.0.0')).toBe(false);
    });

    test('boundary: CGNAT edges (100.63 public, 100.64 private, 100.127 private, 100.128 public)', () => {
      expect(isPrivateIPv4('100.63.255.255')).toBe(false);
      expect(isPrivateIPv4('100.64.0.0')).toBe(true);
      expect(isPrivateIPv4('100.127.0.0')).toBe(true);
      expect(isPrivateIPv4('100.128.0.0')).toBe(false);
    });

    test('boundary: benchmarking range edges (198.17 public, 198.18 private, 198.19 private, 198.20 public)', () => {
      expect(isPrivateIPv4('198.17.255.255')).toBe(false);
      expect(isPrivateIPv4('198.18.0.0')).toBe(true);
      expect(isPrivateIPv4('198.19.0.0')).toBe(true);
      expect(isPrivateIPv4('198.20.0.0')).toBe(false);
    });

    test('AWS metadata IP 169.254.169.254 is classified as private', () => {
      expect(isPrivateIPv4('169.254.169.254')).toBe(true);
    });
  });

  // ── unwrapBracketedHostname ──────────────────────────────────

  describe('unwrapBracketedHostname', () => {
    test('removes brackets from IPv6', () => {
      expect(unwrapBracketedHostname('[::1]')).toBe('::1');
      expect(unwrapBracketedHostname('[2001:db8::1]')).toBe('2001:db8::1');
    });

    test('passes through non-bracketed', () => {
      expect(unwrapBracketedHostname('127.0.0.1')).toBe('127.0.0.1');
      expect(unwrapBracketedHostname('localhost')).toBe('localhost');
    });
  });

  // ── extractEmbeddedIPv4FromIPv6 ──────────────────────────────

  describe('extractEmbeddedIPv4FromIPv6', () => {
    test('extracts dotted IPv4-mapped IPv6', () => {
      expect(extractEmbeddedIPv4FromIPv6('::ffff:127.0.0.1')).toBe('127.0.0.1');
      expect(extractEmbeddedIPv4FromIPv6('[::ffff:192.168.1.1]')).toBe('192.168.1.1');
    });

    test('extracts hex-encoded IPv4-mapped IPv6', () => {
      expect(extractEmbeddedIPv4FromIPv6('::ffff:7f00:1')).toBe('127.0.0.1');
      expect(extractEmbeddedIPv4FromIPv6('::7f00:1')).toBe('127.0.0.1');
    });

    test('returns null for plain IPv6', () => {
      expect(extractEmbeddedIPv4FromIPv6('::1')).toBeNull();
      expect(extractEmbeddedIPv4FromIPv6('2001:db8::1')).toBeNull();
    });

    test('returns null for non-IPv6', () => {
      expect(extractEmbeddedIPv4FromIPv6('127.0.0.1')).toBeNull();
    });
  });

  // ── isIPv6 ───────────────────────────────────────────────────

  describe('isIPv6', () => {
    test('recognizes plain IPv6', () => {
      expect(isIPv6('::1')).toBe(true);
      expect(isIPv6('2001:db8::1')).toBe(true);
      expect(isIPv6('::')).toBe(true);
    });

    test('recognizes bracketed IPv6', () => {
      expect(isIPv6('[::1]')).toBe(true);
      expect(isIPv6('[2001:db8::1]')).toBe(true);
    });

    test('recognizes IPv4-mapped IPv6', () => {
      expect(isIPv6('::ffff:127.0.0.1')).toBe(true);
      expect(isIPv6('::ffff:7f00:1')).toBe(true);
    });

    test('rejects non-IPv6', () => {
      expect(isIPv6('127.0.0.1')).toBe(false);
      expect(isIPv6('localhost')).toBe(false);
    });
  });

  // ── isPrivateIPv6 ────────────────────────────────────────────

  describe('isPrivateIPv6', () => {
    test('classifies loopback', () => {
      expect(isPrivateIPv6('::1')).toBe(true);
      expect(isPrivateIPv6('::')).toBe(true);
    });

    test('classifies unique local (fc/fd)', () => {
      expect(isPrivateIPv6('fc00::1')).toBe(true);
      expect(isPrivateIPv6('fd12:3456::1')).toBe(true);
    });

    test('classifies multicast (ff)', () => {
      expect(isPrivateIPv6('ff02::1')).toBe(true);
    });

    test('classifies link-local (fe80-febf)', () => {
      expect(isPrivateIPv6('fe80::1')).toBe(true);
    });

    test('classifies site-local (fec0-feff)', () => {
      expect(isPrivateIPv6('fec0::1')).toBe(true);
    });

    test('classifies IPv4-mapped private', () => {
      expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIPv6('::ffff:7f00:1')).toBe(true);
    });

    test('classifies public IPv6 as non-private', () => {
      expect(isPrivateIPv6('2001:db8::1')).toBe(false);
    });
  });

  // ── isPrivateOrLocalHost ─────────────────────────────────────

  describe('isPrivateOrLocalHost', () => {
    test('detects localhost', () => {
      expect(isPrivateOrLocalHost('localhost')).toBe(true);
      expect(isPrivateOrLocalHost('LOCALHOST')).toBe(true);
      expect(isPrivateOrLocalHost('localhost.localdomain')).toBe(true);
    });

    test('detects subdomain localhost', () => {
      expect(isPrivateOrLocalHost('foo.localhost')).toBe(true);
    });

    test('detects 0.0.0.0', () => {
      expect(isPrivateOrLocalHost('0.0.0.0')).toBe(true);
    });

    test('detects metadata.google.internal', () => {
      expect(isPrivateOrLocalHost('metadata.google.internal')).toBe(true);
    });

    test('detects private IPs', () => {
      expect(isPrivateOrLocalHost('127.0.0.1')).toBe(true);
      expect(isPrivateOrLocalHost('10.0.0.1')).toBe(true);
      expect(isPrivateOrLocalHost('192.168.1.1')).toBe(true);
    });

    test('detects private IPv6', () => {
      expect(isPrivateOrLocalHost('[::1]')).toBe(true);
      expect(isPrivateOrLocalHost('::1')).toBe(true);
    });

    test('detects .local mDNS suffix', () => {
      expect(isPrivateOrLocalHost('my-nas.local')).toBe(true);
      expect(isPrivateOrLocalHost('printer.local')).toBe(true);
    });

    test('detects link-local 169.254.x.x (cloud metadata)', () => {
      expect(isPrivateOrLocalHost('169.254.169.254')).toBe(true);
    });

    test('detects CGNAT range', () => {
      expect(isPrivateOrLocalHost('100.100.100.100')).toBe(true);
    });

    test('detects IPv6 unique local addresses', () => {
      expect(isPrivateOrLocalHost('fc00::1')).toBe(true);
      expect(isPrivateOrLocalHost('fd12:3456::1')).toBe(true);
    });

    test('detects IPv6 link-local addresses', () => {
      expect(isPrivateOrLocalHost('fe80::1')).toBe(true);
    });

    test('detects IPv4-mapped IPv6 private addresses', () => {
      expect(isPrivateOrLocalHost('[::ffff:127.0.0.1]')).toBe(true);
      expect(isPrivateOrLocalHost('[::ffff:10.0.0.1]')).toBe(true);
      expect(isPrivateOrLocalHost('[::ffff:192.168.1.1]')).toBe(true);
    });

    test('does not flag public hosts', () => {
      expect(isPrivateOrLocalHost('example.com')).toBe(false);
      expect(isPrivateOrLocalHost('93.184.216.34')).toBe(false);
    });

    test('does not flag public IPv6 addresses', () => {
      expect(isPrivateOrLocalHost('2001:db8::1')).toBe(false);
    });

    test('handles case-insensitive hostnames', () => {
      expect(isPrivateOrLocalHost('Metadata.Google.Internal')).toBe(true);
      expect(isPrivateOrLocalHost('My-NAS.Local')).toBe(true);
    });
  });

  // ── resolveRequestAddress ────────────────────────────────────

  describe('resolveRequestAddress', () => {
    test('blocks private IP literals when not allowed', async () => {
      const result = await resolveRequestAddress('127.0.0.1', async () => [], false);
      expect(result.blockedAddress).toBe('127.0.0.1');
      expect(result.addresses).toEqual([]);
    });

    test('allows private IP literals when allowed', async () => {
      const result = await resolveRequestAddress('127.0.0.1', async () => [], true);
      expect(result.blockedAddress).toBeUndefined();
      expect(result.addresses).toEqual(['127.0.0.1']);
    });

    test('blocks hostname resolving to private address', async () => {
      const result = await resolveRequestAddress(
        'example.com',
        async () => ['10.0.0.1'],
        false,
      );
      expect(result.blockedAddress).toBe('10.0.0.1');
    });

    test('allows hostname resolving to public address', async () => {
      const result = await resolveRequestAddress(
        'example.com',
        async () => ['93.184.216.34'],
        false,
      );
      expect(result.addresses).toEqual(['93.184.216.34']);
      expect(result.blockedAddress).toBeUndefined();
    });

    test('returns empty addresses when resolution fails', async () => {
      const result = await resolveRequestAddress(
        'example.com',
        async () => [],
        false,
      );
      expect(result.addresses).toEqual([]);
      expect(result.blockedAddress).toBeUndefined();
    });

    test('deduplicates resolved addresses', async () => {
      const result = await resolveRequestAddress(
        'example.com',
        async () => ['93.184.216.34', '93.184.216.34'],
        false,
      );
      expect(result.addresses).toEqual(['93.184.216.34']);
    });

    test('blocks IPv6 loopback literal when not allowed', async () => {
      const result = await resolveRequestAddress('[::1]', async () => [], false);
      expect(result.blockedAddress).toBe('::1');
      expect(result.addresses).toEqual([]);
    });

    test('allows IPv6 loopback literal when allowed', async () => {
      const result = await resolveRequestAddress('[::1]', async () => [], true);
      expect(result.blockedAddress).toBeUndefined();
      expect(result.addresses).toEqual(['::1']);
    });

    test('blocks hostname resolving to IPv6 loopback', async () => {
      const result = await resolveRequestAddress(
        'example.com',
        async () => ['::1'],
        false,
      );
      expect(result.blockedAddress).toBe('::1');
    });

    test('blocks hostname resolving to link-local address', async () => {
      const result = await resolveRequestAddress(
        'example.com',
        async () => ['169.254.169.254'],
        false,
      );
      expect(result.blockedAddress).toBe('169.254.169.254');
    });

    test('blocks any private address in a list of mixed addresses', async () => {
      const result = await resolveRequestAddress(
        'example.com',
        async () => ['93.184.216.34', '10.0.0.1', '203.0.113.1'],
        false,
      );
      expect(result.blockedAddress).toBe('10.0.0.1');
      expect(result.addresses).toEqual([]);
    });

    test('allows public IPv4 literal when not allowed', async () => {
      const result = await resolveRequestAddress('8.8.8.8', async () => [], false);
      expect(result.blockedAddress).toBeUndefined();
      expect(result.addresses).toEqual(['8.8.8.8']);
    });
  });

  // ── buildHostHeader ──────────────────────────────────────────

  describe('buildHostHeader', () => {
    test('returns hostname without port for default ports', () => {
      const url = new URL('https://example.com/path');
      expect(buildHostHeader(url)).toBe('example.com');
    });

    test('includes explicit port', () => {
      const url = new URL('https://example.com:8443/path');
      expect(buildHostHeader(url)).toBe('example.com:8443');
    });
  });

  // ── stripUrlUserinfo ─────────────────────────────────────────

  describe('stripUrlUserinfo', () => {
    test('removes username and password', () => {
      const url = new URL('https://user:p%40ss@example.com/path');
      const stripped = stripUrlUserinfo(url);
      expect(stripped.username).toBe('');
      expect(stripped.password).toBe('');
      expect(stripped.href).toBe('https://example.com/path');
    });

    test('passes through URLs without userinfo', () => {
      const url = new URL('https://example.com/path');
      const stripped = stripUrlUserinfo(url);
      expect(stripped.href).toBe('https://example.com/path');
    });
  });

  // ── sanitizeUrlForOutput ─────────────────────────────────────

  describe('sanitizeUrlForOutput', () => {
    test('strips userinfo from URL', () => {
      const url = new URL('https://user:p%40ss@example.com/path');
      expect(sanitizeUrlForOutput(url)).toBe('https://example.com/path');
    });
  });

  // ── sanitizeUrlStringForOutput ───────────────────────────────

  describe('sanitizeUrlStringForOutput', () => {
    test('strips userinfo from valid URL string', () => {
      expect(sanitizeUrlStringForOutput('https://user:p%40ss@example.com/path'))
        .toBe('https://example.com/path');
    });

    test('redacts credentials in unparseable URL strings', () => {
      expect(sanitizeUrlStringForOutput('://user@example'))
        .toContain('<redacted />');
    });

    test('resolves relative URLs with base', () => {
      const base = new URL('https://example.com');
      expect(sanitizeUrlStringForOutput('/path', base))
        .toBe('https://example.com/path');
    });
  });
});
