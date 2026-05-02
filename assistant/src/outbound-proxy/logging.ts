/**
 * Safe diagnostic logging helpers for the proxy subsystem.
 *
 * All sanitizers and trace builders are designed to NEVER include secret
 * values by construction -- sanitizers redact sensitive header/query values,
 * and trace builders only reference host patterns, decision kinds, and
 * candidate counts.
 */

import type { PolicyDecision } from "@vellumai/egress-proxy";

const REDACTED = "[REDACTED]";

/**
 * Replace values of sensitive header keys with a redaction placeholder.
 *
 * Matching is case-insensitive -- "Authorization" and "authorization"
 * are both caught. The caller supplies the set of sensitive key names
 * (lowercased) because different credential templates inject into
 * different headers.
 */
export function sanitizeHeaders(
  headers: Record<string, string>,
  sensitiveKeys: string[],
): Record<string, string> {
  const lower = new Set(sensitiveKeys.map((k) => k.toLowerCase()));
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    out[key] = lower.has(key.toLowerCase()) ? REDACTED : value;
  }

  return out;
}

/**
 * Redact query-parameter values for sensitive param names.
 *
 * Returns a URL string where the values of `sensitiveParams` are
 * replaced with the redaction placeholder. Non-sensitive params and
 * the rest of the URL are preserved verbatim.
 */
export function sanitizeUrl(url: string, sensitiveParams: string[]): string {
  if (sensitiveParams.length === 0) return url;

  // Guard against malformed input -- return the URL unchanged if it
  // doesn't contain a query string at all.
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return url;

  try {
    // Build a full URL if given an absolute path, otherwise parse as-is
    const parseable = url.startsWith("/") ? `http://placeholder${url}` : url;
    const parsed = new URL(parseable);
    const lower = new Set(sensitiveParams.map((p) => p.toLowerCase()));

    for (const key of Array.from(parsed.searchParams.keys())) {
      if (lower.has(key.toLowerCase())) {
        parsed.searchParams.set(key, REDACTED);
      }
    }

    // Reconstruct the original shape: if the input was a path we strip
    // the placeholder origin so the caller gets back a relative path.
    if (url.startsWith("/")) {
      return parsed.pathname + parsed.search;
    }
    return parsed.toString();
  } catch {
    // Fail closed: if we can't parse the URL, strip the query string
    // entirely rather than risk leaking secrets in log output.
    return url.slice(0, qIdx);
  }
}

/**
 * Build a log-safe snapshot of an outbound proxy request.
 *
 * `sensitiveKeys` should include header names and query param names
 * that carry credential values (e.g. "Authorization", "api_key").
 */
export function createSafeLogEntry(
  req: { method: string; url: string; headers: Record<string, string> },
  sensitiveKeys: string[],
): { method: string; url: string; headers: Record<string, string> } {
  return {
    method: req.method,
    url: sanitizeUrl(req.url, sensitiveKeys),
    headers: sanitizeHeaders(req.headers, sensitiveKeys),
  };
}

// ---------------------------------------------------------------------------
// Policy/rewrite decision trace
// ---------------------------------------------------------------------------

export interface ProxyDecisionTrace {
  /** Target hostname. */
  host: string;
  /** Target port (null = default for scheme). */
  port: number | null;
  /** Request path. */
  path: string;
  /** Protocol scheme. */
  scheme: "http" | "https";
  /** The decision kind emitted by the policy engine. */
  decisionKind: PolicyDecision["kind"];
  /** Number of candidate templates that matched before disambiguation. */
  candidateCount: number;
  /** The host pattern of the selected template, if any. */
  selectedPattern: string | null;
  /** The credential ID of the selected credential, if any. */
  selectedCredentialId: string | null;
}

/**
 * Strip the query string from a URL path so that secrets passed as
 * query parameters (API keys, tokens) are never recorded in traces.
 */
export function stripQueryString(p: string): string {
  const idx = p.indexOf("?");
  return idx === -1 ? p : p.slice(0, idx);
}

/**
 * Build a structured trace record from a policy decision.
 *
 * Intentionally excludes all secret-bearing fields (header values,
 * storage keys, injected tokens) -- only patterns, counts, and
 * decision metadata are included. Query parameters are stripped from
 * the path to prevent leaking secrets (API keys, tokens) into logs.
 */
export function buildDecisionTrace(
  host: string,
  port: number | null,
  path: string,
  scheme: "http" | "https",
  decision: PolicyDecision,
): ProxyDecisionTrace {
  let candidateCount = 0;
  let selectedPattern: string | null = null;
  let selectedCredentialId: string | null = null;

  switch (decision.kind) {
    case "matched":
      candidateCount = 1;
      selectedPattern = decision.template.hostPattern;
      selectedCredentialId = decision.credentialId;
      break;
    case "ambiguous":
      candidateCount = decision.candidates.length;
      break;
    case "ask_missing_credential":
      candidateCount = decision.matchingPatterns.length;
      break;
    // 'missing', 'unauthenticated', 'ask_unauthenticated' -- no candidates
  }

  return {
    host,
    port,
    path: stripQueryString(path),
    scheme,
    decisionKind: decision.kind,
    candidateCount,
    selectedPattern,
    selectedCredentialId,
  };
}

// ---------------------------------------------------------------------------
// Credential ref resolution trace
// ---------------------------------------------------------------------------

export interface CredentialRefTrace {
  /** The raw refs provided by the caller. */
  rawRefs: string[];
  /** The resolved canonical UUIDs. */
  resolvedIds: string[];
  /** Any refs that could not be resolved. */
  unresolvedRefs: string[];
}

/**
 * Build a credential ref resolution trace for diagnostic logging.
 */
export function buildCredentialRefTrace(
  rawRefs: string[],
  resolvedIds: string[],
  unresolvedRefs: string[],
): CredentialRefTrace {
  return { rawRefs, resolvedIds, unresolvedRefs };
}
