/**
 * Strip sensitive values from URLs before they enter Sentry breadcrumbs.
 *
 * The browser SDK records navigation, `fetch`, and XHR breadcrumbs that
 * include the full URL. URLs in our app can carry auth codes (OAuth
 * redirect), invite tokens, and email query params; the hash fragment
 * is the standard OAuth implicit-flow carrier for `access_token`.
 *
 * Server-side scrubbing in the Sentry dashboard catches CC/SSN/password
 * patterns by default — this module covers the URL surface that the
 * server-side scrubber does not see (because it is content within a
 * structured `data.url` field rather than a free-text message).
 *
 * Reference: https://docs.sentry.io/security-legal-pii/scrubbing/
 */

// Bare `key` is intentionally excluded — too broad (would shadow
// any routing param whose name contains `key`) and the credential
// variants below cover the auth surface.
const SENSITIVE_PARAM_KEYS = new Set([
  "access_key",
  "access_token",
  "apikey",
  "api_key",
  "auth",
  "authorization",
  "code",
  "email",
  "id_token",
  "oauth_code",
  "password",
  "private_key",
  "pwd",
  "refresh_token",
  "secret",
  "session",
  "session_id",
  "sessionid",
  "sig",
  "signature",
  "token",
]);

const REDACTED = "[REDACTED]";

function scrubSearchParams(search: string): string {
  if (!search || search === "?") return search;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  let changed = false;
  for (const key of [...params.keys()]) {
    if (SENSITIVE_PARAM_KEYS.has(key.toLowerCase())) {
      params.set(key, REDACTED);
      changed = true;
    }
  }
  if (!changed) return search;
  const out = params.toString();
  return out ? `?${out}` : "";
}

function scrubHash(hash: string): string {
  if (!hash || hash === "#") return hash;
  // Parametric hashes (OAuth implicit flow: #access_token=…&token_type=…)
  // are redacted wholesale rather than parsed — any `=` in the fragment
  // indicates structured data rather than a route anchor.
  if (hash.includes("=")) return `#${REDACTED}`;
  return hash;
}

export function sanitizeUrl(url: string): string {
  if (!url) return url;
  // Fast path — nothing to scrub when the string has neither query nor
  // fragment. Also avoids `new URL("not a url", base)` succeeding and
  // turning plain strings into percent-encoded paths.
  if (!url.includes("?") && !url.includes("#")) return url;
  try {
    // Relative and protocol-relative URLs are valid breadcrumb inputs
    // (`/path?x=y`, `//host/path?x=y`), so resolve against a dummy base
    // when no scheme is present, then strip the placeholder back off.
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(url);
    const isProtocolRelative = !hasScheme && url.startsWith("//");
    const base = hasScheme ? undefined : "https://placeholder.invalid";
    const parsed = new URL(url, base);
    parsed.search = scrubSearchParams(parsed.search);
    parsed.hash = scrubHash(parsed.hash);
    if (hasScheme) return parsed.toString();
    if (isProtocolRelative) {
      return `//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return url;
  }
}
