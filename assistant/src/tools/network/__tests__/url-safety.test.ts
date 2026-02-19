import { describe, test, expect } from 'bun:test';
import {
  looksLikeHostPortShorthand,
  looksLikePathOnlyInput,
  parseUrl,
  isIPv4,
  isPrivateIPv4,
  isIPv6,
  isPrivateIPv6,
  unwrapBracketedHostname,
  extractEmbeddedIPv4FromIPv6,
  isPrivateOrLocalHost,
  resolveRequestAddress,
  buildHostHeader,
  stripUrlUserinfo,
  sanitizeUrlForOutput,
  sanitizeUrlStringForOutput,
} from '../url-safety.js';

// ---------------------------------------------------------------------------
// looksLikeHostPortShorthand
// ---------------------------------------------------------------------------

describe('looksLikeHostPortShorthand', () => {
  test('matches host:port', () => {
    expect(looksLikeHostPortShorthand('example.com:8080')).toBe(true);
    expect(looksLikeHostPortShorthand('example.com:443')).toBe(true);
  });

  test('matches host:port with path', () => {
    expect(looksLikeHostPortShorthand('example.com:8080/path')).toBe(true);
    expect(looksLikeHostPortShorthand('example.com:443?q=1')).toBe(true);
    expect(looksLikeHostPortShorthand('example.com:443#frag')).toBe(true);
  });

  test('matches bracketed IPv6:port', () => {
    expect(looksLikeHostPortShorthand('[::1]:3000')).toBe(true);
    expect(looksLikeHostPortShorthand('[2001:db8::1]:443')).toBe(true);
  });

  test('rejects plain hostnames without port', () => {
    expect(looksLikeHostPortShorthand('example.com')).toBe(false);
    expect(looksLikeHostPortShorthand('example.com/path')).toBe(false);
  });

  test('rejects full URLs', () => {
    expect(looksLikeHostPortShorthand('https://example.com:443')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// looksLikePathOnlyInput
// ---------------------------------------------------------------------------

describe('looksLikePathOnlyInput', () => {
  test('detects absolute paths', () => {
    expect(looksLikePathOnlyInput('/docs')).toBe(true);
    expect(looksLikePathOnlyInput('/docs/getting-started')).toBe(true);
  });

  test('detects relative paths', () => {
    expect(looksLikePathOnlyInput('./readme')).toBe(true);
    expect(looksLikePathOnlyInput('../parent')).toBe(true);
  });

  test('detects query-only and fragment-only', () => {
    expect(looksLikePathOnlyInput('?q=test')).toBe(true);
    expect(looksLikePathOnlyInput('#section')).toBe(true);
  });

  test('rejects hostnames', () => {
    expect(looksLikePathOnlyInput('example.com')).toBe(false);
    expect(looksLikePathOnlyInput('example.com/docs')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseUrl
// ---------------------------------------------------------------------------

describe('parseUrl', () => {
  test('parses full URLs', () => {
    const url = parseUrl('https://example.com/path');
    expect(url).not.toBeNull();
    expect(url!.hostname).toBe('example.com');
    expect(url!.pathname).toBe('/path');
  });

  test('adds https:// for bare hostnames', () => {
    const url = parseUrl('example.com/docs');
    expect(url).not.toBeNull();
    expect(url!.protocol).toBe('https:');
    expect(url!.hostname).toBe('example.com');
  });

  test('handles host:port shorthand', () => {
    const url = parseUrl('example.com:8080/docs');
    expect(url).not.toBeNull();
    expect(url!.protocol).toBe('https:');
    expect(url!.port).toBe('8080');
  });

  test('returns null for non-string input', () => {
    expect(parseUrl(null)).toBeNull();
    expect(parseUrl(undefined)).toBeNull();
    expect(parseUrl(42)).toBeNull();
  });

  test('returns null for empty strings', () => {
    expect(parseUrl('')).toBeNull();
    expect(parseUrl('   ')).toBeNull();
  });

  test('returns null for path-only input', () => {
    expect(parseUrl('/docs')).toBeNull();
    expect(parseUrl('./readme')).toBeNull();
  });

  test('parses non-http schemes as valid URLs', () => {
    expect(parseUrl('ftp://example.com')).not.toBeNull();
    // 'custom:data' is a valid URL per WHATWG URL spec
    expect(parseUrl('custom:data')).not.toBeNull();
  });

  test('returns null for malformed input', () => {
    expect(parseUrl('://no-scheme')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isIPv4
// ---------------------------------------------------------------------------

describe('isIPv4', () => {
  test('valid IPv4 addresses', () => {
    expect(isIPv4('0.0.0.0')).toBe(true);
    expect(isIPv4('127.0.0.1')).toBe(true);
    expect(isIPv4('192.168.1.1')).toBe(true);
    expect(isIPv4('255.255.255.255')).toBe(true);
    expect(isIPv4('10.0.0.1')).toBe(true);
  });

  test('invalid IPv4 addresses', () => {
    expect(isIPv4('256.0.0.1')).toBe(false);
    expect(isIPv4('1.2.3')).toBe(false);
    expect(isIPv4('1.2.3.4.5')).toBe(false);
    expect(isIPv4('example.com')).toBe(false);
    expect(isIPv4('')).toBe(false);
    expect(isIPv4('abc.def.ghi.jkl')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateIPv4
// ---------------------------------------------------------------------------

describe('isPrivateIPv4', () => {
  test('0.x.x.x is private', () => {
    expect(isPrivateIPv4('0.0.0.0')).toBe(true);
    expect(isPrivateIPv4('0.255.255.255')).toBe(true);
  });

  test('10.x.x.x is private', () => {
    expect(isPrivateIPv4('10.0.0.1')).toBe(true);
    expect(isPrivateIPv4('10.255.255.255')).toBe(true);
  });

  test('127.x.x.x is private', () => {
    expect(isPrivateIPv4('127.0.0.1')).toBe(true);
    expect(isPrivateIPv4('127.255.255.255')).toBe(true);
  });

  test('169.254.x.x is private', () => {
    expect(isPrivateIPv4('169.254.0.1')).toBe(true);
    expect(isPrivateIPv4('169.254.255.255')).toBe(true);
  });

  test('172.16-31.x.x is private', () => {
    expect(isPrivateIPv4('172.16.0.1')).toBe(true);
    expect(isPrivateIPv4('172.31.255.255')).toBe(true);
    expect(isPrivateIPv4('172.15.0.1')).toBe(false);
    expect(isPrivateIPv4('172.32.0.1')).toBe(false);
  });

  test('192.168.x.x is private', () => {
    expect(isPrivateIPv4('192.168.0.1')).toBe(true);
    expect(isPrivateIPv4('192.168.255.255')).toBe(true);
  });

  test('198.18-19.x.x is private', () => {
    expect(isPrivateIPv4('198.18.0.1')).toBe(true);
    expect(isPrivateIPv4('198.19.255.255')).toBe(true);
    expect(isPrivateIPv4('198.17.0.1')).toBe(false);
    expect(isPrivateIPv4('198.20.0.1')).toBe(false);
  });

  test('100.64-127.x.x (CGNAT) is private', () => {
    expect(isPrivateIPv4('100.64.0.1')).toBe(true);
    expect(isPrivateIPv4('100.127.255.255')).toBe(true);
    expect(isPrivateIPv4('100.63.0.1')).toBe(false);
    expect(isPrivateIPv4('100.128.0.1')).toBe(false);
  });

  test('224+ (multicast/reserved) is private', () => {
    expect(isPrivateIPv4('224.0.0.1')).toBe(true);
    expect(isPrivateIPv4('255.255.255.255')).toBe(true);
  });

  test('public addresses are not private', () => {
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
    expect(isPrivateIPv4('93.184.216.34')).toBe(false);
    expect(isPrivateIPv4('1.1.1.1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// unwrapBracketedHostname
// ---------------------------------------------------------------------------

describe('unwrapBracketedHostname', () => {
  test('strips brackets from IPv6', () => {
    expect(unwrapBracketedHostname('[::1]')).toBe('::1');
    expect(unwrapBracketedHostname('[2001:db8::1]')).toBe('2001:db8::1');
  });

  test('returns plain hostnames unchanged', () => {
    expect(unwrapBracketedHostname('example.com')).toBe('example.com');
    expect(unwrapBracketedHostname('127.0.0.1')).toBe('127.0.0.1');
  });

  test('returns partial brackets unchanged', () => {
    expect(unwrapBracketedHostname('[only-open')).toBe('[only-open');
    expect(unwrapBracketedHostname('only-close]')).toBe('only-close]');
  });
});

// ---------------------------------------------------------------------------
// extractEmbeddedIPv4FromIPv6
// ---------------------------------------------------------------------------

describe('extractEmbeddedIPv4FromIPv6', () => {
  test('extracts dotted IPv4-mapped addresses', () => {
    expect(extractEmbeddedIPv4FromIPv6('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(extractEmbeddedIPv4FromIPv6('::ffff:192.168.1.1')).toBe('192.168.1.1');
  });

  test('extracts hex-form IPv4-mapped addresses', () => {
    expect(extractEmbeddedIPv4FromIPv6('::ffff:7f00:1')).toBe('127.0.0.1');
  });

  test('extracts IPv4-compatible addresses', () => {
    expect(extractEmbeddedIPv4FromIPv6('::7f00:1')).toBe('127.0.0.1');
  });

  test('handles bracketed notation', () => {
    expect(extractEmbeddedIPv4FromIPv6('[::ffff:127.0.0.1]')).toBe('127.0.0.1');
  });

  test('handles zone IDs', () => {
    expect(extractEmbeddedIPv4FromIPv6('::ffff:127.0.0.1%eth0')).toBe('127.0.0.1');
  });

  test('returns null for pure IPv6', () => {
    expect(extractEmbeddedIPv4FromIPv6('2001:db8::1')).toBeNull();
    expect(extractEmbeddedIPv4FromIPv6('::1')).toBeNull();
  });

  test('returns null for non-IPv6', () => {
    expect(extractEmbeddedIPv4FromIPv6('example.com')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isIPv6
// ---------------------------------------------------------------------------

describe('isIPv6', () => {
  test('valid IPv6 addresses', () => {
    expect(isIPv6('::1')).toBe(true);
    expect(isIPv6('::')).toBe(true);
    expect(isIPv6('2001:db8::1')).toBe(true);
    expect(isIPv6('fe80::1')).toBe(true);
  });

  test('bracketed IPv6', () => {
    expect(isIPv6('[::1]')).toBe(true);
    expect(isIPv6('[2001:db8::1]')).toBe(true);
  });

  test('IPv4-mapped IPv6', () => {
    expect(isIPv6('::ffff:127.0.0.1')).toBe(true);
    expect(isIPv6('::ffff:7f00:1')).toBe(true);
  });

  test('IPv6 with zone ID', () => {
    expect(isIPv6('fe80::1%eth0')).toBe(true);
  });

  test('rejects non-IPv6', () => {
    expect(isIPv6('example.com')).toBe(false);
    expect(isIPv6('127.0.0.1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateIPv6
// ---------------------------------------------------------------------------

describe('isPrivateIPv6', () => {
  test('loopback addresses', () => {
    expect(isPrivateIPv6('::')).toBe(true);
    expect(isPrivateIPv6('::1')).toBe(true);
  });

  test('unique local (fc/fd)', () => {
    expect(isPrivateIPv6('fc00::1')).toBe(true);
    expect(isPrivateIPv6('fd12::1')).toBe(true);
  });

  test('multicast (ff)', () => {
    expect(isPrivateIPv6('ff02::1')).toBe(true);
    expect(isPrivateIPv6('ff01::1')).toBe(true);
  });

  test('link-local (fe8x-fefx)', () => {
    expect(isPrivateIPv6('fe80::1')).toBe(true);
    expect(isPrivateIPv6('feb0::1')).toBe(true);
    expect(isPrivateIPv6('fec0::1')).toBe(true);
    expect(isPrivateIPv6('fef0::1')).toBe(true);
  });

  test('IPv4-mapped private addresses', () => {
    expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIPv6('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIPv6('::ffff:7f00:1')).toBe(true);
  });

  test('IPv4-mapped public addresses are not private', () => {
    expect(isPrivateIPv6('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIPv6('::ffff:93.184.216.34')).toBe(false);
  });

  test('public IPv6 addresses are not private', () => {
    expect(isPrivateIPv6('2001:db8::1')).toBe(false);
    expect(isPrivateIPv6('2607:f8b0:4004:800::200e')).toBe(false);
  });

  test('handles bracketed notation', () => {
    expect(isPrivateIPv6('[::1]')).toBe(true);
    expect(isPrivateIPv6('[fe80::1]')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isPrivateOrLocalHost
// ---------------------------------------------------------------------------

describe('isPrivateOrLocalHost', () => {
  test('localhost variants', () => {
    expect(isPrivateOrLocalHost('localhost')).toBe(true);
    expect(isPrivateOrLocalHost('LOCALHOST')).toBe(true);
    expect(isPrivateOrLocalHost('localhost.localdomain')).toBe(true);
    expect(isPrivateOrLocalHost('0.0.0.0')).toBe(true);
  });

  test('subdomain localhost', () => {
    expect(isPrivateOrLocalHost('foo.localhost')).toBe(true);
    expect(isPrivateOrLocalHost('app.localhost')).toBe(true);
  });

  test('.local suffix', () => {
    expect(isPrivateOrLocalHost('mypc.local')).toBe(true);
  });

  test('metadata.google.internal', () => {
    expect(isPrivateOrLocalHost('metadata.google.internal')).toBe(true);
  });

  test('private IPv4', () => {
    expect(isPrivateOrLocalHost('127.0.0.1')).toBe(true);
    expect(isPrivateOrLocalHost('10.0.0.1')).toBe(true);
    expect(isPrivateOrLocalHost('192.168.1.1')).toBe(true);
  });

  test('private IPv6', () => {
    expect(isPrivateOrLocalHost('::1')).toBe(true);
    expect(isPrivateOrLocalHost('[::1]')).toBe(true);
    expect(isPrivateOrLocalHost('fe80::1')).toBe(true);
  });

  test('public hostnames', () => {
    expect(isPrivateOrLocalHost('example.com')).toBe(false);
    expect(isPrivateOrLocalHost('google.com')).toBe(false);
  });

  test('public IPs', () => {
    expect(isPrivateOrLocalHost('8.8.8.8')).toBe(false);
    expect(isPrivateOrLocalHost('93.184.216.34')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveRequestAddress
// ---------------------------------------------------------------------------

describe('resolveRequestAddress', () => {
  test('blocks private IPs when not allowed', async () => {
    const result = await resolveRequestAddress('127.0.0.1', async () => [], false);
    expect(result.blockedAddress).toBe('127.0.0.1');
    expect(result.addresses).toEqual([]);
  });

  test('allows private IPs when allowed', async () => {
    const result = await resolveRequestAddress('127.0.0.1', async () => [], true);
    expect(result.addresses).toEqual(['127.0.0.1']);
    expect(result.blockedAddress).toBeUndefined();
  });

  test('blocks hostnames resolving to private IPs', async () => {
    const result = await resolveRequestAddress(
      'evil.example',
      async () => ['10.0.0.5'],
      false,
    );
    expect(result.blockedAddress).toBe('10.0.0.5');
  });

  test('allows hostnames resolving to public IPs', async () => {
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
      'nonexistent.example',
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

  test('handles bracketed IPv6 directly', async () => {
    const result = await resolveRequestAddress('[::1]', async () => [], false);
    expect(result.blockedAddress).toBe('::1');
  });

  test('allows bracketed IPv6 when allowed', async () => {
    const result = await resolveRequestAddress('[::1]', async () => [], true);
    expect(result.addresses).toEqual(['::1']);
  });
});

// ---------------------------------------------------------------------------
// buildHostHeader
// ---------------------------------------------------------------------------

describe('buildHostHeader', () => {
  test('returns hostname only for default ports', () => {
    const url = new URL('https://example.com/path');
    expect(buildHostHeader(url)).toBe('example.com');
  });

  test('includes port for non-default ports', () => {
    const url = new URL('https://example.com:8443/path');
    expect(buildHostHeader(url)).toBe('example.com:8443');
  });
});

// ---------------------------------------------------------------------------
// stripUrlUserinfo / sanitizeUrlForOutput / sanitizeUrlStringForOutput
// ---------------------------------------------------------------------------

describe('stripUrlUserinfo', () => {
  test('removes username and password', () => {
    const url = new URL('https://example.com/path');
    url.username = 'user';
    url.password = ['p', 'w'].join('');
    const stripped = stripUrlUserinfo(url);
    expect(stripped.username).toBe('');
    expect(stripped.password).toBe('');
    expect(stripped.hostname).toBe('example.com');
    expect(stripped.pathname).toBe('/path');
  });

  test('preserves URL without credentials', () => {
    const url = new URL('https://example.com/path');
    const stripped = stripUrlUserinfo(url);
    expect(stripped.href).toBe('https://example.com/path');
  });
});

describe('sanitizeUrlForOutput', () => {
  test('strips credentials from output', () => {
    const url = new URL('https://example.com/path');
    url.username = 'user';
    url.password = ['t', 'o', 'k'].join('');
    expect(sanitizeUrlForOutput(url)).toBe('https://example.com/path');
  });
});

describe('sanitizeUrlStringForOutput', () => {
  test('strips credentials from valid URL string', () => {
    const url = new URL('https://example.com/path');
    url.username = 'user';
    url.password = ['p', 'w'].join('');
    expect(sanitizeUrlStringForOutput(url.href))
      .toBe('https://example.com/path');
  });

  test('uses regex fallback for malformed URLs', () => {
    const result = sanitizeUrlStringForOutput('scheme://user@host/path');
    expect(result).not.toContain('user@');
  });

  test('resolves relative to base URL', () => {
    const base = new URL('https://example.com');
    expect(sanitizeUrlStringForOutput('/docs', base)).toBe('https://example.com/docs');
  });
});
