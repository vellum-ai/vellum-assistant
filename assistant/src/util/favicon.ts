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

/** Match any IP literal — IPv4 dotted-quad or IPv6 (bracketed or bare with a colon).
 *  We reject every IP from the favicon path because we don't reverse-lookup hosts,
 *  so a raw IP — public or private — would expose the literal to Google when the
 *  client renders the icon. DNS names are fine; only literals are rejected. */
function isIPLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.startsWith("[") || host.includes(":")) return true;
  return false;
}

/** Deterministic favicon URL for a host using Google's s2 service.
 *  Returns undefined for empty/malformed hosts, raw IP literals, and any host
 *  isPrivateOrLocalHost flags. Callers omit the field on undefined so we never
 *  leak internal hostnames or arbitrary IPs to Google when clients render the
 *  icon. */
export function faviconUrlForDomain(domain: string): string | undefined {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed || trimmed.includes("/") || trimmed.includes(" ")) {
    return undefined;
  }
  const hostOnly = stripPort(trimmed);
  if (!hostOnly || isIPLiteral(hostOnly) || isPrivateOrLocalHost(hostOnly)) {
    return undefined;
  }
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOnly)}&sz=64`;
}
