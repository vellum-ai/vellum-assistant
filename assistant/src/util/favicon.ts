/** Deterministic favicon URL for a host using Google's s2 service.
 *  Returns undefined for empty or malformed hosts so callers can omit
 *  the field rather than emit a broken URL. */
export function faviconUrlForDomain(domain: string): string | undefined {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed || trimmed.includes("/") || trimmed.includes(" ")) {
    return undefined;
  }
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(trimmed)}&sz=64`;
}
