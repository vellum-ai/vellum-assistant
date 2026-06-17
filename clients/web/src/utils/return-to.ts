import { isVellumDomain } from "@/utils/domains";

const ABSOLUTE_URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Sanitize a `returnTo` URL parameter to prevent open-redirect attacks.
 *
 * Relative paths (strings starting with `/`) and absolute URLs whose
 * hostname belongs to the vellum.ai domain family are allowed through.
 * All other absolute URLs (`https://…`, `//…`), non-path strings,
 * and nullish / empty values resolve to the provided `fallback`.
 */
export function sanitizeReturnTo(
  value: string | null | undefined,
  fallback: string,
): string {
  if (!value) {
    return fallback;
  }

  // Allow absolute URLs from any *.vellum.ai domain.
  // This is safe because we control all vellum.ai subdomains, and works
  // in both server and client contexts (no env var dependency).
  //
  // Important: only treat values that START with a URL scheme as absolute.
  // Relative paths can legitimately contain `https://...` inside query params
  // (e.g. `/accounts/chrome-extension/start?redirect_uri=https://...`).
  if (ABSOLUTE_URL_SCHEME_RE.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && isVellumDomain(url.hostname)) {
        return value;
      }
    } catch {
      // Malformed URL — fall through to block
    }
    return fallback;
  }

  // Block protocol-relative URLs (e.g. "//evil.com")
  if (value.startsWith("//")) {
    return fallback;
  }

  // Block backslash-based open redirects (e.g. "/\evil.com").
  // Browsers normalise `\` to `/` per the WHATWG URL spec, so `/\` is
  // treated as `//` — a protocol-relative URL that navigates off-site.
  if (value.includes("\\")) {
    return fallback;
  }

  // Only allow paths that start with "/"
  if (!value.startsWith("/")) {
    return fallback;
  }

  return value;
}
