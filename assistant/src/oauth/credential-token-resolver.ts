/**
 * Centralized access-token key resolution for OAuth and manual-token providers.
 *
 * All code that needs to read or check the presence of a provider's access
 * token should go through {@link getConnectionAccessTokenResult} rather than
 * inlining provider-specific path logic. This ensures that `oauth status`,
 * `oauth ping`, credential health checks, and runtime token lookups all
 * agree on where the access token lives.
 *
 * Manual-token providers (e.g. slack_channel, telegram) store their primary
 * token under `credential/<provider>/<field>` via the generic credential
 * store, while standard OAuth providers use `oauth_connection/<id>/access_token`.
 */

import { oauthConnectionAccessTokenPath } from "@vellumai/credential-storage";

import { credentialKey } from "../security/credential-key.js";
import {
  getSecureKeyResultAsync,
  type SecureKeyResult,
} from "../security/secure-keys.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface ConnectionAccessTokenResult {
  /** The access token value, or undefined if not found / backend unreachable. */
  value: string | undefined;
  /** True when the credential backend is temporarily unreachable. */
  unreachable: boolean;
  /** The secure-store key that was resolved for this provider + connection. */
  key: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Return the secure-store key holding the primary access token for a
 * manual-token provider, or null for OAuth providers whose tokens live at
 * `oauth_connection/<id>/access_token`.
 *
 * Manual-token providers store their tokens under `credential/<provider>/<field>`
 * via the generic credential store, so any code that validates tokens for these
 * providers (e.g. credential-health checks) must resolve the path through here
 * rather than assuming the OAuth access-token path.
 */
export function manualTokenAccessCredentialKey(
  provider: string,
): string | null {
  switch (provider) {
    case "slack_channel":
      return credentialKey("slack_channel", "bot_token");
    case "telegram":
      return credentialKey("telegram", "bot_token");
    default:
      return null;
  }
}

/**
 * Resolve the secure-store key for a provider's access token.
 *
 * - `slack_channel` -> `credential/slack_channel/bot_token`
 * - `telegram`      -> `credential/telegram/bot_token`
 * - all normal OAuth -> `oauth_connection/<connectionId>/access_token`
 */
export function resolveAccessTokenKey(
  provider: string,
  connectionId: string,
): string {
  return (
    manualTokenAccessCredentialKey(provider) ??
    oauthConnectionAccessTokenPath(connectionId)
  );
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Look up the access token for a provider/connection pair, resolving the
 * correct secure-store key automatically.
 *
 * Returns the token value, whether the backend was unreachable, and the
 * key that was used — giving callers everything they need to diagnose
 * token-path mismatches.
 */
export async function getConnectionAccessTokenResult(opts: {
  provider: string;
  connectionId: string;
}): Promise<ConnectionAccessTokenResult> {
  const key = resolveAccessTokenKey(opts.provider, opts.connectionId);
  const result: SecureKeyResult = await getSecureKeyResultAsync(key);
  return {
    value: result.value,
    unreachable: result.unreachable,
    key,
  };
}
