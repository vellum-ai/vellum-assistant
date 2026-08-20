/**
 * Claude Code OAuth config + capture/store helpers for the "Connect Claude"
 * ACP flow.
 *
 * This module owns the verified Claude OAuth endpoints/client and the pure
 * helpers the daemon connect routes call: the loopback path builds an
 * authorize URL against a localhost redirect, while the cloud paste path
 * builds one against the manual redirect page and parses the `code#state`
 * string the user copies back. Both converge on `storeAcpClaudeToken`, which
 * writes the `acp/claude_oauth_token` vault field the ACP broker reads at
 * spawn time and provisions the `acp_spawn` read policy.
 */

import { credentialKey } from "../security/credential-key.js";
import type { OAuth2Config } from "../security/oauth2.js";
import {
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import {
  ACP_OAUTH_TOKEN_FIELD,
  ACP_SERVICE,
  classifyAnthropicToken,
} from "./acp-credentials.js";
import {
  ACP_CLAUDE_OAUTH_USAGE_DESCRIPTION,
  acpSpawnCredentialDenialReason,
  repairAcpSpawnPolicy,
} from "./prepare-agent-env.js";

const log = getLogger("acp:claude-oauth");

/**
 * Verified Claude Code public OAuth client. PKCE-only (no client secret);
 * the single `user:inference` scope is what the ACP adapter's
 * `CLAUDE_CODE_OAUTH_TOKEN` requires.
 */
export const CLAUDE_OAUTH_CONFIG: OAuth2Config = {
  // The claude.ai-account authorize endpoint, matching the Claude Code CLI's
  // own CLAUDE_AI_AUTHORIZE_URL. Shared by both flows: the loopback path
  // builds its URL from this in `prepareOAuth2Flow`, the manual path in
  // `buildClaudeAuthorizeUrl`. Only the claude.com/cai host completes a
  // grant; the legacy claude.ai host still renders a working-looking consent
  // screen but rejects every authorize POST, so a wrong host here looks
  // functional until the final click of a real sign-in.
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  tokenExchangeUrl: "https://platform.claude.com/v1/oauth/token",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  scopes: ["user:inference"],
  scopeSeparator: " ",
  // Anthropic's token endpoint diverges from the OAuth2 defaults: it expects a
  // JSON body and validates the `state` echoed back at exchange (which is why
  // the manual redirect renders a `code#state` pair). Without both, the exchange
  // fails with HTTP 400.
  tokenExchangeBodyFormat: "json",
  sendStateInTokenExchange: true,
};

/**
 * Manual redirect target for the cloud paste path: Claude renders the
 * `code#state` string on this page for the user to copy back.
 */
export const CLAUDE_MANUAL_REDIRECT_URI =
  "https://platform.claude.com/oauth/code/callback";

/**
 * Build the Claude authorize URL for the MANUAL (paste) PKCE flow.
 *
 * `code=true` tells Claude to render the `code#state` string on the callback
 * page for the user to copy, which is the whole mechanism of the manual flow;
 * Claude rejects a manual-redirect grant without it. The loopback flow
 * performs a real redirect instead and must NOT send it; that URL is built
 * separately in `prepareOAuth2Flow`, which is why this builder can include
 * the param unconditionally.
 */
export function buildClaudeAuthorizeUrl(
  redirectUri: string,
  pkce: { codeChallenge: string; state: string },
): string {
  const params = new URLSearchParams({
    code: "true",
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
 * field and provision the policy the broker applies at spawn time: grant the
 * `acp_spawn` read and lift any domain restriction. Throws when the backing
 * store rejects the write.
 */
export async function storeAcpClaudeToken(token: string): Promise<void> {
  const stored = await setSecureKeyAsync(
    credentialKey(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD),
    token,
  );
  if (!stored) {
    throw new Error("Failed to store Claude OAuth token in secure storage.");
  }
  // Repair rather than merely ensure the policy: an explicit Connect is a
  // deliberate opt-in to ACP, so this widens a credential the broker would
  // otherwise keep denying the spawn read on, which would dead-loop the Connect
  // card on every auto-continue.
  repairAcpSpawnPolicy(
    ACP_OAUTH_TOKEN_FIELD,
    ACP_CLAUDE_OAUTH_USAGE_DESCRIPTION,
  );
}

/**
 * Whether a usable Claude OAuth token is present in the `acp/claude_oauth_token`
 * vault field for this workspace. A read-only check — never returns the token
 * value — used by the connect-status route so the web client can self-heal the
 * inline Connect Claude affordance once the account is connected.
 *
 * A legacy vault entry may hold an Anthropic **API key** (`sk-ant-api…`) in this
 * field — the footgun the write path now rejects for new writes. Such a value is
 * treated as NOT connected: it 401s when injected as `CLAUDE_CODE_OAUTH_TOKEN` at
 * spawn, so keeping Connect offered (rather than self-dismissing) lets the user
 * repair the bad entry by connecting a real OAuth token.
 *
 * Likewise, a token the spawn's broker read would be denied (an explicit
 * `allowedTools` that omits `acp_spawn`, or a domain-restricted policy) is NOT
 * connected: the vault holds a value but every spawn fails, so self-dismissing
 * the card would hide the only repair CTA. That half of the answer is delegated
 * to `acpSpawnCredentialDenialReason`, which evaluates the exact policy the
 * spawn-time broker read applies, so "connected" means precisely "the spawn
 * would get this token". The token-shape guard stays here instead: the broker
 * knows nothing about Anthropic token formats.
 */
export async function hasAcpClaudeToken(): Promise<boolean> {
  const token = await getSecureKeyAsync(
    credentialKey(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD),
  );
  if (token == null || token.length === 0) {
    return false;
  }
  if (classifyAnthropicToken(token) === "api_key") {
    return false;
  }
  const denialReason = acpSpawnCredentialDenialReason(ACP_OAUTH_TOKEN_FIELD);
  if (denialReason !== undefined) {
    log.debug(
      { field: ACP_OAUTH_TOKEN_FIELD, reason: denialReason },
      "Connect Claude status: token present but spawn read would be denied",
    );
    return false;
  }
  return true;
}
