/**
 * Claude Code OAuth config + capture/store helpers for the "Connect Claude"
 * ACP flow.
 *
 * This module owns the verified Claude OAuth endpoints/client and the pure
 * helpers the daemon connect routes call: the loopback path builds an
 * authorize URL against a localhost redirect, while the cloud paste path
 * builds one against the manual redirect page and parses the `code#state`
 * string the user copies back. Both converge on `storeAcpClaudeTokens`, which
 * writes the `acp/claude_oauth_token` vault field the ACP broker reads at
 * spawn time and provisions the `acp_spawn` read policy.
 *
 * It also owns the two companion fields captured by the same exchange, the
 * refresh token and the access token's expiry, plus the accessors over them.
 * The policy for WHEN to spend that refresh token lives next door in
 * `claude-token-refresh.ts`.
 */

import { computeExpiresAt, isTokenExpired } from "@vellumai/credential-storage";

import { credentialKey } from "../security/credential-key.js";
import type { OAuth2Config } from "../security/oauth2.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import {
  acpSpawnCanReadCredential,
  grantAcpSpawnPolicy,
} from "./acp-credential-policy.js";
import {
  ACP_OAUTH_EXPIRES_AT_FIELD,
  ACP_OAUTH_REFRESH_TOKEN_FIELD,
  ACP_OAUTH_TOKEN_FIELD,
  ACP_SERVICE,
  classifyAnthropicToken,
} from "./acp-credentials.js";

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

/** Tokens as returned by an authorization-code exchange or a refresh. */
export interface AcpClaudeTokens {
  accessToken: string;
  refreshToken?: string;
  /** Lifetime in seconds, as the provider reports it. */
  expiresIn?: number;
}

function key(field: string): string {
  return credentialKey(ACP_SERVICE, field);
}

/**
 * Store a captured Claude OAuth token set in the `acp/claude_oauth_*` vault
 * fields and provision the `acp_spawn` read policy so the broker can inject the
 * access token at spawn time. Throws when the backing store rejects the write.
 *
 * The refresh token and expiry are written as a SET with the access token: when
 * the provider returns neither (which we cannot rule out for this client and
 * scope), any previously stored values are cleared rather than left behind. A
 * stale refresh token paired with a newly connected access token would
 * otherwise renew into the credential from a previous connect.
 *
 * Only the access-token field gets credential metadata. `serverUse` refuses any
 * field without metadata, so the refresh token and expiry stay unreachable
 * through the broker and can never be injected into a spawned agent's env.
 */
export async function storeAcpClaudeTokens(
  tokens: AcpClaudeTokens,
): Promise<void> {
  const stored = await setSecureKeyAsync(
    key(ACP_OAUTH_TOKEN_FIELD),
    tokens.accessToken,
  );
  if (!stored) {
    throw new Error("Failed to store Claude OAuth token in secure storage.");
  }

  await writeOrClear(ACP_OAUTH_REFRESH_TOKEN_FIELD, tokens.refreshToken);
  const expiresAt = computeExpiresAt(tokens.expiresIn);
  await writeOrClear(
    ACP_OAUTH_EXPIRES_AT_FIELD,
    expiresAt == null ? undefined : String(expiresAt),
  );
  // Force-grant acp_spawn (union) rather than merely ensure it: an explicit
  // Connect is a deliberate opt-in to ACP, so this repairs a credential whose
  // explicit allowedTools omitted acp_spawn — otherwise the broker keeps denying
  // the spawn read and the Connect card dead-loops on every auto-continue.
  grantAcpSpawnPolicy(
    ACP_OAUTH_TOKEN_FIELD,
    "Claude OAuth token for ACP agent authentication",
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
 * Likewise, a token the `acp_spawn` policy can't read (an explicit
 * `allowedTools` that omits `acp_spawn`) is NOT connected: the vault holds a
 * value but the spawn's broker read is denied, so self-dismissing the card would
 * hide the only repair CTA while every spawn keeps failing. Keep the card up in
 * that denied-policy case too.
 *
 * An EXPIRED token with no way to renew it is the same shape of problem, and is
 * likewise NOT connected. Presence alone used to answer this question, which
 * meant a dead token reported "connected" and the inline Connect card
 * self-dismissed the moment it mounted, leaving the user with a failed run and
 * no way to act on it. An expired token that still has a refresh token IS
 * connected: `ensureFreshAcpClaudeToken` renews it on the next spawn.
 */
export async function hasAcpClaudeToken(): Promise<boolean> {
  const token = await getSecureKeyAsync(key(ACP_OAUTH_TOKEN_FIELD));
  if (
    token == null ||
    token.length === 0 ||
    classifyAnthropicToken(token) === "api_key" ||
    !acpSpawnCanReadCredential(ACP_OAUTH_TOKEN_FIELD)
  ) {
    return false;
  }
  if (!(await isAcpClaudeTokenExpiring())) {
    return true;
  }
  return await hasAcpClaudeRefreshToken();
}

// ---------------------------------------------------------------------------
// Refresh material accessors
// ---------------------------------------------------------------------------
//
// Read/write helpers for the two companion fields, kept here with the rest of
// the Claude ACP credential storage. `claude-token-refresh.ts` drives them.

async function writeOrClear(
  field: string,
  value: string | undefined,
): Promise<void> {
  if (value) {
    await setSecureKeyAsync(key(field), value);
    return;
  }
  await deleteSecureKeyAsync(key(field));
}

/**
 * The stored absolute expiry in epoch milliseconds, or null when unknown.
 *
 * Unknown is the norm for tokens connected before the expiry was recorded, and
 * is treated as "assume usable": we cannot tell fresh from expired, and
 * guessing expired would refresh (or worse, discard) a perfectly good token.
 */
async function readExpiresAt(): Promise<number | null> {
  const raw = await getSecureKeyAsync(key(ACP_OAUTH_EXPIRES_AT_FIELD));
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Whether the stored access token is past its recorded expiry, or close enough
 * that it should be renewed before use. False when no expiry was recorded.
 */
export async function isAcpClaudeTokenExpiring(): Promise<boolean> {
  return isTokenExpired(await readExpiresAt());
}

/** The stored refresh token, or null when none was captured. */
export async function readAcpClaudeRefreshToken(): Promise<string | null> {
  const token = await getSecureKeyAsync(key(ACP_OAUTH_REFRESH_TOKEN_FIELD));
  return token != null && token.length > 0 ? token : null;
}

/** Whether renewal material is on hand, without revealing it. */
export async function hasAcpClaudeRefreshToken(): Promise<boolean> {
  return (await readAcpClaudeRefreshToken()) != null;
}

/**
 * Drop the refresh token and expiry, leaving the access token in place. Called
 * when the provider rejects the refresh token, so the connected check stops
 * reporting a credential that can no longer be renewed.
 */
export async function clearAcpClaudeRefreshMaterial(): Promise<void> {
  await writeOrClear(ACP_OAUTH_REFRESH_TOKEN_FIELD, undefined);
  await writeOrClear(ACP_OAUTH_EXPIRES_AT_FIELD, undefined);
}
