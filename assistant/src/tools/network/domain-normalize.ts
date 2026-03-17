/**
 * Registrable domain normalization utility.
 *
 * Wraps `tldts` to provide deterministic domain parsing used by
 * credential domain policy enforcement.
 */

import { parse } from "tldts";

export interface DomainInfo {
  /** Original hostname, lowercased and stripped of trailing dot. */
  hostname: string;
  /** Registrable domain (eTLD+1), e.g. "example.co.uk" for "foo.bar.example.co.uk". */
  registrableDomain: string | null;
}

/**
 * Parse and normalize a hostname or URL into its domain components.
 *
 * Handles:
 * - Full URLs (extracts hostname)
 * - Bare hostnames
 * - Trailing dots
 * - Mixed case
 * - Punycode/IDN domains
 *
 * Returns `null` for inputs that cannot be parsed into a valid hostname
 * (e.g. IP addresses, localhost, empty strings).
 */
export function normalizeDomain(input: string): DomainInfo | null {
  if (!input || typeof input !== "string") return null;

  let hostname: string;

  // If input looks like a URL, extract the hostname
  try {
    if (input.includes("://")) {
      const url = new URL(input);
      hostname = url.hostname;
    } else {
      hostname = input;
    }
  } catch {
    hostname = input;
  }

  // Strip trailing port from bare hostnames (no scheme).
  // Without this, "example.com:8080" is misidentified as IPv6 by isIPAddress.
  if (!input.includes("://")) {
    hostname = hostname.replace(/:\d+$/, "");
  }

  // Normalize: lowercase, strip trailing dot
  hostname = hostname.toLowerCase().replace(/\.$/, "");

  if (!hostname) return null;

  // Reject IP addresses and localhost - they don't have registrable domains
  if (isIPAddress(hostname) || hostname === "localhost") {
    return null;
  }

  // Reject malformed hostnames. Each DNS label must start and end with an
  // alphanumeric and contain only alphanumerics/hyphens - no consecutive dots,
  // no labels starting or ending with hyphens.
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(
      hostname,
    )
  ) {
    return null;
  }

  const result = parse(hostname);
  const registrableDomain = result.domain || null;

  return {
    hostname,
    registrableDomain,
  };
}

function isIPAddress(hostname: string): boolean {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  // IPv6 (bracketed or bare)
  if (hostname.startsWith("[") || hostname.includes(":")) return true;
  return false;
}
