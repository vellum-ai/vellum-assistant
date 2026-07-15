/**
 * Claude Code OAuth config + capture/store helpers for the "Connect Claude"
 * ACP flow.
 *
 * This module owns the verified Claude OAuth endpoints/client and the pure
 * helpers the daemon connect routes call: the loopback path (PR 5) builds an
 * authorize URL against a localhost redirect, while the cloud paste path
 * (PR 6) builds one against the manual redirect page and parses the
 * `code#state` string the user copies back. Both converge on
 * `storeAcpClaudeToken`, which writes the `acp/claude_oauth_token` vault field
 * the ACP broker reads at spawn time and provisions the `acp_spawn` read
 * policy.
 */

import { credentialKey } from "../security/credential-key.js";
import type { OAuth2Config } from "../security/oauth2.js";
import { setSecureKeyAsync } from "../security/secure-keys.js";
import { ACP_OAUTH_TOKEN_FIELD, ACP_SERVICE } from "./acp-credentials.js";
import { ensureAcpCredentialPolicy } from "./prepare-agent-env.js";

/**
 * Verified Claude Code public OAuth client. PKCE-only (no client secret);
 * the single `user:inference` scope is what the ACP adapter's
 * `CLAUDE_CODE_OAUTH_TOKEN` requires.
 */
export const CLAUDE_OAUTH_CONFIG: OAuth2Config = {
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenExchangeUrl: "https://platform.claude.com/v1/oauth/token",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  scopes: ["user:inference"],
  scopeSeparator: " ",
};

/**
 * Manual redirect target for the cloud paste path (PR 6): Claude renders the
 * `code#state` string on this page for the user to copy back.
 */
export const CLAUDE_MANUAL_REDIRECT_URI =
  "https://platform.claude.com/oauth/code/callback";

/** Build the Claude authorize URL for a PKCE flow. */
export function buildClaudeAuthorizeUrl(
  redirectUri: string,
  pkce: { codeChallenge: string; state: string },
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLAUDE_OAUTH_CONFIG.clientId,
    redirect_uri: redirectUri,
    scope: CLAUDE_OAUTH_CONFIG.scopes.join(CLAUDE_OAUTH_CONFIG.scopeSeparator),
    state: pkce.state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${CLAUDE_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`;
}

/**
 * Parse the `code#state` string the manual redirect page shows the user.
 * Throws on malformed input (missing the `#` separator).
 */
export function parseManualClaudeCode(input: string): {
  code: string;
  state: string;
} {
  const hashIndex = input.indexOf("#");
  if (hashIndex === -1) {
    throw new Error(
      "Malformed Claude authorization code: expected `code#state`.",
    );
  }
  return {
    code: input.slice(0, hashIndex),
    state: input.slice(hashIndex + 1),
  };
}

/**
 * Store a captured Claude OAuth token in the `acp/claude_oauth_token` vault
 * field and provision the `acp_spawn` read policy so the broker can inject it
 * at spawn time. Throws when the backing store rejects the write.
 */
export async function storeAcpClaudeToken(token: string): Promise<void> {
  const stored = await setSecureKeyAsync(
    credentialKey(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD),
    token,
  );
  if (!stored) {
    throw new Error("Failed to store Claude OAuth token in secure storage.");
  }
  ensureAcpCredentialPolicy(
    ACP_OAUTH_TOKEN_FIELD,
    "Claude OAuth token for ACP agent authentication",
  );
}
