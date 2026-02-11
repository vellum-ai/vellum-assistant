import { lookup } from 'node:dns/promises';

export type ResolveHostAddresses = (hostname: string) => Promise<string[]>;

export function looksLikeHostPortShorthand(value: string): boolean {
  if (/^\[[0-9a-fA-F:.%]+\]:\d+(?:[/?#]|$)/.test(value)) {
    return true;
  }
  return /^[^/?#@\s:]+:\d+(?:[/?#]|$)/.test(value);
}

export function looksLikePathOnlyInput(value: string): boolean {
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('?') || value.startsWith('#');
}

export function parseUrl(input: unknown): URL | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value) return null;

  if (looksLikeHostPortShorthand(value)) {
    try {
      return new URL(`https://${value}`);
    } catch {
      return null;
    }
  }

  try {
    return new URL(value);
  } catch {
    // Allow shorthand like "example.com/docs".
  }

  if (looksLikePathOnlyInput(value)) {
    return null;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    return null;
  }

  try {
    return new URL(`https://${value}`);
  } catch {
    return null;
  }
}

export function isIPv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;

  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    if (value < 0 || value > 255) return false;
  }

  return true;
}

export function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  const [a, b] = parts;

  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;

  return false;
}

export function unwrapBracketedHostname(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

export function extractEmbeddedIPv4FromIPv6(hostname: string): string | null {
  const normalized = unwrapBracketedHostname(hostname).split('%')[0].toLowerCase();

  const dottedMatch = normalized.match(/^(?:(?:(?:0:){5}|::)ffff:|(?:(?:0:){6}|::))(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dottedMatch) {
    return isIPv4(dottedMatch[1]) ? dottedMatch[1] : null;
  }

  const hexMatch = normalized.match(/^(?:(?:(?:0:){5}|::)ffff:|(?:(?:0:){6}|::))([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hexMatch) return null;

  const hi = Number.parseInt(hexMatch[1], 16);
  const lo = Number.parseInt(hexMatch[2], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;

  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export function isIPv6(hostname: string): boolean {
  if (extractEmbeddedIPv4FromIPv6(hostname)) return true;

  const unwrapped = unwrapBracketedHostname(hostname);
  if (!unwrapped.includes(':')) return false;
  const stripped = unwrapped.split('%')[0];
  return /^[0-9a-fA-F:]+$/.test(stripped);
}

export function isPrivateIPv6(hostname: string): boolean {
  const normalized = unwrapBracketedHostname(hostname).split('%')[0].toLowerCase();

  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('ff')) return true;
  if (
    normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('fec')
    || normalized.startsWith('fed')
    || normalized.startsWith('fee')
    || normalized.startsWith('fef')
  ) {
    return true;
  }

  const mappedIPv4 = extractEmbeddedIPv4FromIPv6(hostname);
  if (mappedIPv4) {
    return isPrivateIPv4(mappedIPv4);
  }

  return false;
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = unwrapBracketedHostname(hostname).toLowerCase();

  if (
    host === 'localhost' ||
    host === 'localhost.localdomain' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost')
  ) {
    return true;
  }
  if (host === 'metadata.google.internal') {
    return true;
  }
  if (isIPv4(host)) {
    return isPrivateIPv4(host);
  }
  if (isIPv6(host)) {
    return isPrivateIPv6(host);
  }
  return false;
}

export async function resolveHostAddresses(hostname: string): Promise<string[]> {
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  } catch {
    return [];
  }
}

export async function resolveRequestAddress(
  hostname: string,
  resolveHost: ResolveHostAddresses,
  allowPrivateNetwork: boolean,
): Promise<{ addresses: string[]; blockedAddress?: string }> {
  const normalizedHost = unwrapBracketedHostname(hostname);

  if (isIPv4(normalizedHost) || isIPv6(normalizedHost)) {
    if (!allowPrivateNetwork && isPrivateOrLocalHost(normalizedHost)) {
      return { addresses: [], blockedAddress: normalizedHost };
    }
    return { addresses: [normalizedHost] };
  }

  const addresses = [...new Set((await resolveHost(normalizedHost)).map((address) => unwrapBracketedHostname(address)))];
  if (addresses.length === 0) {
    return { addresses: [] };
  }

  if (!allowPrivateNetwork) {
    for (const address of addresses) {
      if (isPrivateOrLocalHost(address)) {
        return { addresses: [], blockedAddress: address };
      }
    }
  }

  return { addresses };
}

export function buildHostHeader(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

export function stripUrlUserinfo(url: URL): URL {
  const sanitized = new URL(url.href);
  sanitized.username = '';
  sanitized.password = '';
  return sanitized;
}

export function sanitizeUrlForOutput(url: URL): string {
  const sanitized = stripUrlUserinfo(url);
  return sanitized.href;
}

export function sanitizeUrlStringForOutput(url: string, base?: URL): string {
  try {
    const parsed = base ? new URL(url, base) : new URL(url);
    return sanitizeUrlForOutput(parsed);
  } catch {
    return url.replace(/\/\/([^/?#\s@]+)@/g, '//[REDACTED]@');
  }
}
