/**
 * Canonical URL normalization for web tool inputs, shared by the gateway's
 * risk classifiers and the daemon's URL safety checks.
 *
 * A URL a model passes to `web_fetch` / `network_request` reaches more than
 * one consumer, and they must agree on what counts as the same target: the
 * gateway builds the trust-rule ladder from it, and anything that later
 * compares a URL to a saved rule has to fold the same spellings together. Two
 * normalizations would mean two answers, so it lives here rather than in
 * either process.
 *
 * Data-only in spirit: no imports, no config, no I/O.
 */

/** Whether a bare `host:port` (or `[v6]:port`) shorthand was written. */
export function looksLikeHostPortShorthand(value: string): boolean {
  if (/^\[[0-9a-fA-F:.%]+\]:\d+(?:[/?#]|$)/.test(value)) {
    return true;
  }
  return /^[^/?#@\s:]+:\d+(?:[/?#]|$)/.test(value);
}

/** Whether the input is a path, query, or fragment rather than a URL. */
export function looksLikePathOnlyInput(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("?") ||
    value.startsWith("#")
  );
}

/**
 * Strip the parts of a URL that must not affect a trust decision, and fold
 * the encodings that would otherwise let one URL wear two spellings.
 *
 * Percent-escaped path segments are decoded (`/%70rivate` and `/private` are
 * one path, so a path-scoped rule cannot be bypassed by escaping), a trailing
 * root dot is dropped from the hostname, and fragment and userinfo are
 * removed: the fragment never reaches the server, and credentials in the
 * authority must never end up in a saved rule.
 */
export function canonicalizeWebUrl(parsed: URL): URL {
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";

  try {
    parsed.pathname = decodeURI(parsed.pathname);
  } catch {
    // Keep the URL parser's canonical form when decoding fails.
  }

  if (parsed.hostname.endsWith(".")) {
    parsed.hostname = parsed.hostname.replace(/\.+$/, "");
  }

  return parsed;
}

/**
 * Parse and canonicalize a web tool's `url` input, or `null` when it is not a
 * URL this system will fetch.
 *
 * Accepts `https://host/path`, `http://…`, bare `host/path`, and `host:port`
 * shorthand. Rejects path-only input and any other scheme (`file:`, `data:`,
 * `javascript:`), so a non-http target can never acquire a web trust rule.
 */
export function normalizeWebUrl(rawUrl: string): URL | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  if (looksLikeHostPortShorthand(trimmed)) {
    try {
      return canonicalizeWebUrl(new URL(`https://${trimmed}`));
    } catch {
      return null;
    }
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return canonicalizeWebUrl(parsed);
    }
    return null;
  } catch {
    // Not an absolute URL; fall through to the shorthand forms.
  }

  if (looksLikePathOnlyInput(trimmed)) {
    return null;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  }

  try {
    return canonicalizeWebUrl(new URL(`https://${trimmed}`));
  } catch {
    return null;
  }
}
