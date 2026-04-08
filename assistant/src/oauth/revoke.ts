/**
 * Best-effort upstream OAuth token revocation.
 *
 * Mirrors the platform's `try_revoke_token` (django/app/assistant/oauth/providers/base.py).
 * The HTTP shape is fixed: POST + application/x-www-form-urlencoded body, no auth headers
 * (credentials are expected to live in the body via {access_token}/{client_id} substitution),
 * 10 second timeout, all errors swallowed and logged as warnings.
 *
 * The body template grammar supports two substitution variables:
 * - `{access_token}` — replaced with the connection's access token
 * - `{client_id}` — replaced with the OAuth app's client ID
 *
 * Non-string template values are coerced via String(value), matching platform's str(value)
 * fallback. Substitution replaces ALL occurrences of each placeholder within a value
 * (matching Python's str.replace default) and preserves literal semantics for replacement
 * text (no $-pattern expansion). Returns void on every path — callers must NOT depend on
 * the upstream result.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("oauth-revoke");

const REVOKE_TIMEOUT_MS = 10_000;

export async function tryRevokeOAuthToken(params: {
  provider: string;
  revokeUrl: string;
  bodyTemplate: Record<string, unknown> | null;
  accessToken: string;
  clientId: string;
}): Promise<void> {
  const { provider, revokeUrl, bodyTemplate, accessToken, clientId } = params;

  // Build the substituted body. An empty/null template still produces an empty
  // body, which is a valid request shape — some revoke endpoints accept an empty
  // body and rely on the URL alone (we still POST per spec).
  const body: Record<string, string> = {};
  if (bodyTemplate) {
    for (const [key, value] of Object.entries(bodyTemplate)) {
      if (typeof value === "string") {
        // Use .replaceAll with function callbacks to:
        // 1. Replace ALL occurrences (matching Python's str.replace default).
        // 2. Bypass String.replace's $-pattern expansion (e.g. $&, $', $`, $$),
        //    so an access token containing "$&" substitutes literally.
        // This mirrors platform's str.replace() semantics character-for-character.
        body[key] = value
          .replaceAll("{access_token}", () => accessToken)
          .replaceAll("{client_id}", () => clientId);
      } else {
        body[key] = String(value);
      }
    }
  }

  try {
    const resp = await fetch(revokeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log.warn(
        { provider, status: resp.status, revokeUrl },
        "Upstream OAuth revoke returned non-2xx (best-effort, ignoring)",
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { provider, revokeUrl, err: message },
      "Failed to revoke OAuth token upstream (best-effort, ignoring)",
    );
  }
}
