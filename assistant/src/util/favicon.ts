import { isPrivateOrLocalHost } from "../tools/network/url-safety.js";

/** Strip the trailing `:port` from a host string. IPv6 hosts are bracketed
 *  ("[::1]:8080" → "[::1]"); IPv4/DNS hosts have a single colon ("host:8080" → "host"). */
function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const lastColon = host.lastIndexOf(":");
  if (lastColon === -1) return host;
  return host.slice(0, lastColon);
}

/** Deterministic favicon URL for a host using Google's s2 service.
 *  Returns undefined for empty/malformed hosts and for private, localhost,
 *  or raw-IP hosts so we never leak internal hostnames to Google when
 *  clients render the icon. Callers omit the field on undefined. */
export function faviconUrlForDomain(domain: string): string | undefined {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed || trimmed.includes("/") || trimmed.includes(" ")) {
    return undefined;
  }
  const hostOnly = stripPort(trimmed);
  if (!hostOnly || isPrivateOrLocalHost(hostOnly)) {
    return undefined;
  }
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOnly)}&sz=64`;
}
