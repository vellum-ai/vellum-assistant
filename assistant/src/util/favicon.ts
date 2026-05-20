import { isPrivateOrLocalHost } from "../tools/network/url-safety.js";

/** Deterministic favicon URL for a host using Google's s2 service.
 *  Returns undefined for empty/malformed hosts and for private, localhost,
 *  or raw-IP hosts so we never leak internal hostnames to Google when
 *  clients render the icon. Callers omit the field on undefined. */
export function faviconUrlForDomain(domain: string): string | undefined {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed || trimmed.includes("/") || trimmed.includes(" ")) {
    return undefined;
  }
  if (isPrivateOrLocalHost(trimmed)) {
    return undefined;
  }
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(trimmed)}&sz=64`;
}
