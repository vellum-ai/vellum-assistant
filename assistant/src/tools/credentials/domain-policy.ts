/**
 * Domain policy matcher for credential usage enforcement.
 *
 * Uses registrable-domain semantics: a credential allowed for "example.com"
 * can be used on "login.example.com" or "app.example.com", but not on
 * "notexample.com" or "example.co.uk".
 */

import { normalizeDomain } from '../network/domain-normalize.js';

/**
 * Check whether a request host is allowed by the credential's domain policy.
 *
 * @param requestHost - The hostname or URL of the current request/page
 * @param allowedDomains - The credential's allowed domain list
 * @returns true if the request host matches an allowed domain
 *
 * Matching rules:
 * 1. Exact hostname match (case-insensitive)
 * 2. Registrable-domain match with subdomain allowance
 * 3. Deny if requestHost is missing, invalid, IP, or localhost
 * 4. Deny if allowedDomains is empty or undefined (fail-closed)
 */
export function isDomainAllowed(requestHost: string, allowedDomains: string[]): boolean {
  if (!allowedDomains || allowedDomains.length === 0) return false;

  const requestInfo = normalizeDomain(requestHost);
  if (!requestInfo) return false;

  // Require a valid registrable domain — rejects malformed hostnames that
  // normalizeDomain doesn't explicitly filter (e.g. strings with spaces/symbols).
  if (!requestInfo.registrableDomain) return false;

  for (const allowed of allowedDomains) {
    const allowedInfo = normalizeDomain(allowed);
    if (!allowedInfo) continue;

    // Exact hostname match
    if (requestInfo.hostname === allowedInfo.hostname) return true;

    // Registrable-domain match: request's registrable domain must equal
    // the allowed entry's registrable domain, and the allowed entry
    // must itself be a registrable domain (not a subdomain).
    if (
      requestInfo.registrableDomain &&
      allowedInfo.registrableDomain &&
      requestInfo.registrableDomain === allowedInfo.registrableDomain &&
      allowedInfo.hostname === allowedInfo.registrableDomain
    ) {
      return true;
    }
  }

  return false;
}
