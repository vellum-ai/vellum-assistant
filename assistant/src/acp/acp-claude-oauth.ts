/**
 * Claude Code OAuth config + capture/store helpers for the "Connect Claude"
 * ACP flow.
 *
 * This module owns the verified Claude OAuth endpoints/client and the pure
 * helpers the daemon connect routes call: the loopback path builds an
 * authorize URL against a localhost redirect, while the cloud paste path
 * builds one against the manual redirect page and parses the `code#state`
 * string the user copies back. Both converge on
 * `storeConnectedAcpClaudeTokens`, which writes the `acp/claude_oauth_token`
 * vault field the ACP broker reads at spawn time and provisions the
 * `acp_spawn` read policy.
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
 * Write a Claude OAuth token set to the `acp/claude_oauth_*` vault fields.
 * Throws when the backing store rejects any of the three writes.
 *
 * The refresh token and expiry are written as a SET with the access token: when
 * the provider returns neither (which we cannot rule out for this client and
 * scope), any previously stored values are cleared rather than left behind. A
 * stale refresh token paired with a newly connected access token would
 * otherwise renew into the credential from a previous connect. That invariant
 * is only worth as much as the writes that enforce it, so a failed companion
 * write or clear is fatal here rather than silently leaving a mismatched set.
 *
 * Only the access-token field gets credential metadata. `serverUse` refuses any
 * field without metadata, so the refresh token and expiry stay unreachable
 * through the broker and can never be injected into a spawned agent's env.
 */
async function writeTokenSet(tokens: AcpClaudeTokens): Promise<void> {
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
}

/**
 * Persist the token set captured by an explicit "Connect Claude" flow, and
 * provision the `acp_spawn` read policy so the broker can inject the access
 * token at spawn time.
 *
 * The policy grant belongs to THIS path only. Connecting is a deliberate user
 * opt-in to ACP, which is what makes force-granting (union) defensible: it
 * repairs a credential whose explicit `allowedTools` omitted `acp_spawn`,
 * without which the broker keeps denying the spawn read and the Connect card
 * dead-loops on every auto-continue. A background token renewal carries no such
 * consent, so it must use {@link persistRefreshedAcpClaudeTokens} instead.
 */
export async function storeConnectedAcpClaudeTokens(
  tokens: AcpClaudeTokens,
): Promise<void> {
  await writeTokenSet(tokens);
  grantAcpSpawnPolicy(
    ACP_OAUTH_TOKEN_FIELD,
    "Claude OAuth token for ACP agent authentication",
  );
}

/**
 * Persist a token set obtained by renewing an existing credential, leaving the
 * read policy exactly as it was.
 *
 * A renewal happens on a passive spawn with no user in the loop, so it must not
 * widen what the credential is allowed to do. Granting `acp_spawn` here would
 * let a background refresh silently restore a permission a user or admin had
 * explicitly removed from `allowedTools`, turning a denied credential into a
 * readable one without anyone asking.
 */
export async function persistRefreshedAcpClaudeTokens(
  tokens: AcpClaudeTokens,
): Promise<void> {
  await writeTokenSet(tokens);
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
 * likewise NOT connected: the card has to stay up so the user can reconnect,
 * because nothing else will repair the credential. An expired token that still
 * has a refresh token IS connected, since `ensureFreshAcpClaudeToken` renews it
 * on the next spawn and there is nothing for the user to do.
 *
 * The recorded expiry is therefore load-bearing for this answer, and the code
 * that drops refresh material must leave it in place. See
 * {@link clearAcpClaudeRefreshToken}.
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

/**
 * Write a companion field, or delete it when there is no value.
 *
 * Both outcomes are checked. The store signals failure by return value rather
 * than by throwing (`setSecureKeyAsync` returns false, `deleteSecureKeyAsync`
 * returns `"error"` on timeout), so ignoring them would let a backend hiccup
 * report success while leaving the three fields out of sync: an access token
 * with no way to renew it, or worse, a NEW access token still paired with a
 * PREVIOUS connect's refresh token, which is the exact mismatch the set-write
 * semantics exist to prevent.
 */
async function writeOrClear(
  field: string,
  value: string | undefined,
): Promise<void> {
  if (value) {
    const stored = await setSecureKeyAsync(key(field), value);
    if (!stored) {
      throw new Error(
        `Failed to store Claude OAuth ${field} in secure storage.`,
      );
    }
    return;
  }
  const result = await deleteSecureKeyAsync(key(field));
  if (result === "error") {
    throw new Error(
      `Failed to clear Claude OAuth ${field} from secure storage.`,
    );
  }
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
 * Drop the refresh token, KEEPING the recorded expiry and the access token.
 * Called when the provider rejects the refresh token.
 *
 * The expiry has to survive. `hasAcpClaudeToken()` reads "not connected" from
 * the combination of an expired token and no refresh token; clearing the expiry
 * as well would make `readExpiresAt()` return null, which
 * {@link isAcpClaudeTokenExpiring} treats as "assume usable", and the dead
 * credential would report itself connected and dismiss the user's only repair
 * CTA.
 */
export async function clearAcpClaudeRefreshToken(): Promise<void> {
  await writeOrClear(ACP_OAUTH_REFRESH_TOKEN_FIELD, undefined);
}

/**
 * Forget everything we know about renewing the stored access token: both the
 * refresh token and the recorded expiry.
 *
 * For when the access token is replaced by a path that knows nothing about
 * either, which is every write outside the Connect flow (`credentials set`, the
 * secret-collection route, a prompted credential). The companion fields
 * describe the PREVIOUS token, and keeping them against a new one is wrong
 * twice over: a stale past expiry makes a valid token report as not connected,
 * and a stale refresh token can be spent to overwrite the token that was just
 * pasted. Clearing both lands on "no expiry recorded", which reads as assume
 * usable, and no renewal material, which is the truth.
 */
export async function forgetAcpClaudeRenewalState(): Promise<void> {
  await writeOrClear(ACP_OAUTH_REFRESH_TOKEN_FIELD, undefined);
  await writeOrClear(ACP_OAUTH_EXPIRES_AT_FIELD, undefined);
}

/**
 * Call after ANY successful credential write that did not come from the Connect
 * flow, so a hand-provisioned Claude token does not inherit the previous one's
 * renewal state. A no-op for every other service and field.
 *
 * `storeConnectedAcpClaudeTokens` is the only writer that keeps the three
 * `acp/claude_oauth_*` fields consistent. The generic credential writers
 * (`credentials set`, the secret-collection route, a prompted credential) reach
 * the access-token field directly, and the headless instructions in
 * `prepare-agent-env.ts` actively point users at one of them, so this is a
 * supported route rather than an edge case.
 *
 * Best-effort by contract: the token itself is already stored, so a failure to
 * tidy the companion fields must not fail the caller's write. Callers log and
 * continue.
 */
export async function forgetAcpClaudeRenewalStateOnForeignWrite(
  service: string,
  field: string,
): Promise<void> {
  if (service !== ACP_SERVICE || field !== ACP_OAUTH_TOKEN_FIELD) {
    return;
  }
  await forgetAcpClaudeRenewalState();
}
