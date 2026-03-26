/**
 * Generic, data-driven identity verifier for OAuth providers.
 *
 * Replaces per-provider hand-coded `identityVerifier` functions with a
 * single function that interprets the declarative identity configuration
 * stored in the `oauth_providers` DB table (identityUrl, identityMethod,
 * identityHeaders, identityBody, identityResponsePaths, identityFormat,
 * identityOkField).
 */

import type { OAuthProviderRow } from "./oauth-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Traverse a nested object by a dot-separated path (e.g. "data.viewer.email"). */
function getNestedValue(obj: unknown, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Safely parse a JSON string, returning a fallback on failure or null/undefined input. */
function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (value == null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify the user's identity after a successful OAuth token exchange.
 *
 * Returns a human-readable account identifier (e.g. email, @username, or
 * a formatted string like "@user (team)") or `undefined` when:
 * - the provider has no identity URL configured
 * - the identity request fails or returns a non-OK status
 * - the response cannot be parsed into an identifier
 *
 * This function is intentionally non-throwing — identity verification is
 * always best-effort.
 */
export async function verifyIdentity(
  providerRow: OAuthProviderRow,
  accessToken: string,
): Promise<string | undefined> {
  const { identityUrl: rawUrl } = providerRow;
  if (!rawUrl) return undefined;

  try {
    // Interpolate ${accessToken} in the URL (HubSpot pattern)
    const urlContainsToken = rawUrl.includes("${accessToken}");
    const url = rawUrl.replace("${accessToken}", accessToken);

    // Build headers
    const parsedHeaders = safeJsonParse<Record<string, string>>(
      providerRow.identityHeaders,
      {},
    );
    const headers: Record<string, string> = {
      ...parsedHeaders,
    };
    // Only add the Authorization header if the token is not embedded in the URL
    if (!urlContainsToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    // Build request init
    const method = providerRow.identityMethod ?? "GET";
    const init: RequestInit = { method, headers };

    // Add body if present
    if (providerRow.identityBody != null) {
      const bodyValue = safeJsonParse<unknown>(
        providerRow.identityBody,
        providerRow.identityBody,
      );
      if (typeof bodyValue === "string") {
        init.body = bodyValue;
      } else {
        init.body = JSON.stringify(bodyValue);
      }
    }

    // Make the request
    const resp = await fetch(url, init);
    if (!resp.ok) return undefined;

    const body: unknown = await resp.json();

    // Check OK field (Slack pattern: body.ok must be truthy)
    if (providerRow.identityOkField) {
      const okValue = getNestedValue(body, providerRow.identityOkField);
      if (!okValue) return undefined;
    }

    // Parse response paths
    const responsePaths = safeJsonParse<string[]>(
      providerRow.identityResponsePaths,
      [],
    );
    if (responsePaths.length === 0) return undefined;

    const { identityFormat } = providerRow;

    // Simple mode: no format template — return the first non-null path value
    if (!identityFormat) {
      for (const path of responsePaths) {
        const value = getNestedValue(body, path);
        if (value != null) return String(value);
      }
      return undefined;
    }

    // Format mode: build a lookup map from all paths, then interpolate
    const pathValues = new Map<string, string | undefined>();
    for (const path of responsePaths) {
      const value = getNestedValue(body, path);
      pathValues.set(path, value != null ? String(value) : undefined);
    }

    // Replace ${path} tokens in the format string
    let result = identityFormat;
    let allResolved = true;
    for (const [path, value] of pathValues) {
      if (value != null) {
        result = result.replace(`\${${path}}`, value);
      } else {
        allResolved = false;
      }
    }

    if (allResolved) return result;

    // Fallback: if some tokens couldn't be resolved, try cleaning up
    // the format string by removing unresolved tokens and their surrounding
    // punctuation (parentheses, spaces).
    // First, try removing unresolved tokens with their surrounding parens/space
    // e.g. "@${user} (${team})" with missing team -> "@user"
    let cleaned = identityFormat;
    for (const [path, value] of pathValues) {
      if (value != null) {
        cleaned = cleaned.replace(`\${${path}}`, value);
      } else {
        // Remove patterns like " (${path})" or " ${path}" or "(${path})"
        cleaned = cleaned.replace(
          new RegExp(`\\s*\\(?\\$\\{${path.replace(/\./g, "\\.")}\\}\\)?`, "g"),
          "",
        );
      }
    }

    cleaned = cleaned.trim();
    if (cleaned) return cleaned;

    // Last resort: return the first non-null path value
    for (const value of pathValues.values()) {
      if (value != null) return value;
    }

    return undefined;
  } catch {
    // Non-fatal — identity verification is best-effort
    return undefined;
  }
}
