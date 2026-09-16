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
 * spawn time, persists any refresh token and expiry the exchange returned,
 * and provisions the `acp_spawn` read policy.
 *
 * Refresh, expiry, and the bound-access digest are stored without credential
 * metadata so the broker cannot hand them to a spawned agent. The policy for
 * when to spend the refresh token lives in `claude-token-refresh.ts`.
 */

import { computeExpiresAt, isTokenExpired } from "@vellumai/credential-storage";

import { credentialKey } from "../security/credential-key.js";
import type { OAuth2Config } from "../security/oauth2.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { claudeTokenDigest } from "./acp-auth-marker-store.js";
import {
  ACP_OAUTH_ACCESS_DIGEST_FIELD,
  ACP_OAUTH_EXPIRES_AT_FIELD,
  ACP_OAUTH_REFRESH_TOKEN_FIELD,
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
 * Serializes every Claude OAuth token-set write (Connect, renewal persist,
 * companion clear) so a compare-and-write cannot interleave with another
 * writer. The network refresh itself stays outside this queue.
 */
let tokenWriteQueue: Promise<unknown> = Promise.resolve();

function withAcpClaudeTokenWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = tokenWriteQueue.then(fn, fn);
  tokenWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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
 * Digest of the Claude OAuth token secure storage holds right now, or
 * `undefined` when it holds none.
 *
 * The credential a marker is judged against. A configured
 * `CLAUDE_CODE_OAUTH_TOKEN` that Claude has already refused stands down at the
 * next spawn, so once a token carries a marker the vault value is what a spawn
 * goes on to resolve, and comparing against it answers whether the marker
 * still describes the credential in use.
 *
 * Read on demand rather than cached. The vault is the authority on what it
 * holds, and a copy of that answer in this process is a second one that has to
 * be kept in step with every write, including writes this process did not
 * make.
 *
 * Lives here rather than beside the comparison it feeds because this module is
 * already the one authorised to read this vault field (see the importer
 * allowlist in `credential-security-invariants`). The digest is all that
 * leaves; the token itself never does.
 */
export async function storedClaudeTokenDigest(): Promise<string | undefined> {
  const token = await usableStoredClaudeToken();
  return token ? claudeTokenDigest(token) : undefined;
}

/** Tokens as returned by an authorization-code exchange or a refresh. */
export interface AcpClaudeTokens {
  accessToken: string;
  refreshToken?: string;
  /** Lifetime in seconds, as the provider reports it. */
  expiresIn?: number;
}

function vaultKey(field: string): string {
  return credentialKey(ACP_SERVICE, field);
}

/**
 * Write a companion field, or delete it when there is no value.
 *
 * Both outcomes are checked. The store signals failure by return value rather
 * than by throwing (`setSecureKeyAsync` returns false, `deleteSecureKeyAsync`
 * returns `"error"` on timeout), so ignoring them would let a backend hiccup
 * report success while leaving the token-set fields out of sync: an access
 * token with no way to renew it, or a new access token still paired with a
 * previous connect's refresh token.
 */
async function writeOrClear(
  field: string,
  value: string | undefined,
): Promise<void> {
  if (value) {
    const stored = await setSecureKeyAsync(vaultKey(field), value);
    if (!stored) {
      throw new Error(
        `Failed to store Claude OAuth ${field} in secure storage.`,
      );
    }
    return;
  }
  const result = await deleteSecureKeyAsync(vaultKey(field));
  if (result === "error") {
    throw new Error(
      `Failed to clear Claude OAuth ${field} from secure storage.`,
    );
  }
}

/**
 * Write a Claude OAuth token set to the `acp/claude_oauth_*` vault fields.
 * Throws when the backing store rejects any of the writes.
 *
 * The refresh token and expiry are written as a set with the access token:
 * when the provider returns neither, any previously stored values are cleared
 * rather than left behind. A stale refresh token paired with a newly connected
 * access token would otherwise renew into the credential from a previous
 * connect.
 *
 * Only the access-token field gets credential metadata. `serverUse` refuses
 * any field without metadata, so the refresh token and expiry stay
 * unreachable through the broker and cannot be injected into a spawned
 * agent's env.
 */
async function writeConnectedTokenSet(tokens: AcpClaudeTokens): Promise<void> {
  await withAcpClaudeTokenWrite(async () => {
    const stored = await setSecureKeyAsync(
      vaultKey(ACP_OAUTH_TOKEN_FIELD),
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
    const hasRenewal = Boolean(tokens.refreshToken) || expiresAt != null;
    await writeOrClear(
      ACP_OAUTH_ACCESS_DIGEST_FIELD,
      hasRenewal ? claudeTokenDigest(tokens.accessToken) : undefined,
    );
  });
}

/**
 * Store a captured Claude OAuth token set in the `acp/claude_oauth_*` vault
 * fields and provision the policy the broker applies at spawn time: grant the
 * `acp_spawn` read and lift any domain restriction. Throws when the backing
 * store rejects the write.
 *
 * A string argument is treated as an access-token-only write and clears any
 * companion refresh or expiry fields so they cannot describe a previous token.
 */
export async function storeAcpClaudeToken(
  tokens: string | AcpClaudeTokens,
): Promise<void> {
  const tokenSet: AcpClaudeTokens =
    typeof tokens === "string" ? { accessToken: tokens } : tokens;
  await writeConnectedTokenSet(tokenSet);
  // Repair rather than merely ensure the policy: an explicit Connect is a
  // deliberate opt-in to ACP, so this widens a credential the broker would
  // otherwise keep denying the spawn read on, which would dead-loop the Connect
  // card on every auto-continue.
  repairAcpSpawnPolicy(
    ACP_OAUTH_TOKEN_FIELD,
    ACP_CLAUDE_OAUTH_USAGE_DESCRIPTION,
  );
  // Again, because the write above already ran this and the policy it repairs
  // is what decides the answer. A token whose `acp_spawn` read was denied is
  // not usable at the moment `setSecureKeyAsync` asks, so that pass declines
  // to retire anything, and the repair on the line above is what makes it
  // usable. Running it a second time is safe: taking the registry is
  // idempotent, and the invalidation is a refetch trigger.
  //
  // Never allowed to fail or delay the store. The token is written either way,
  // and these are notifications: losing one costs a client a stale card until
  // its next snapshot, while waiting on one holds the user at "signing in"
  // while a scan finishes.
  void notifyAcpConnectRetired().catch((err: unknown) => {
    log.warn(
      { err },
      "ACP Connect card notification failed after a token store",
    );
  });
}

/**
 * Tell the rest of the system that a usable Claude token now exists.
 *
 * Two things only clients and the credential prompt can act on. The card
 * registry is in-memory and about a card on screen rather than about the
 * credential, so no marker answers for it, and left standing the prompt keeps
 * redirecting at a card the new token just made stale. The invalidation tells
 * other clients to re-read the snapshot, which they otherwise would not until
 * navigation or reconnect.
 *
 * Neither retires anything by itself. A card is retired by its marker no
 * longer matching the credential a spawn would resolve, which is decided when
 * the marker is read, so a failure here costs freshness rather than
 * correctness.
 *
 * Does nothing for a value a spawn could not use. A bulk restore can land an
 * api-key-shaped token, or one the policy blocks, and the marker comparison
 * keeps the card up for exactly that reason.
 */
export async function notifyAcpConnectRetired(): Promise<void> {
  if (!(await hasAcpClaudeToken())) {
    return;
  }
  // Dropped per conversation, and only where the failure it stands for has
  // actually stopped being shown. A writer can store the very token Claude
  // rejected, which passes the usability check above and changes nothing about
  // the failure: the snapshot goes on serving that marker, so forgetting the
  // entry would leave the credential prompt opening a second prompt beside a
  // card that is still there. Asking the markers is the same question the
  // snapshot answers, rather than a proxy for it.
  const { conversationsWithRaisedAcpConnectCard, dropAcpConnectCardRaised } =
    await import("./acp-connect-card-state.js");
  for (const conversationId of conversationsWithRaisedAcpConnectCard()) {
    if (!(await acpConnectCardStillWarranted(conversationId))) {
      dropAcpConnectCardRaised(conversationId);
    }
  }
  const { publishSyncInvalidation } =
    await import("../runtime/sync/sync-publisher.js");
  const { SYNC_TAGS } = await import("../daemon/message-types/sync.js");
  await publishSyncInvalidation([SYNC_TAGS.acpAuthRecovery]);
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
 *
 * An expired token with no refresh token is the same shape of problem, and is
 * likewise NOT connected: the card has to stay up so the user can reconnect.
 * An expired token that still has a refresh token IS connected, because
 * `ensureFreshAcpClaudeToken` renews it on the next spawn.
 */
export async function hasAcpClaudeToken(): Promise<boolean> {
  return (await usableStoredClaudeToken()) !== undefined;
}

/**
 * The stored Claude token, but only when a spawn would actually get it.
 *
 * One definition of usable for both callers. "Is the account connected" and
 * "which credential would a spawn resolve" are the same question asked for
 * different reasons, and answering them separately is how they drift: a value
 * this rejects still has a digest, so a marker judged against that digest is
 * withheld while the next spawn cannot authenticate, leaving the user with no
 * card and no working token.
 */
async function usableStoredClaudeToken(): Promise<string | undefined> {
  const token = await getSecureKeyAsync(vaultKey(ACP_OAUTH_TOKEN_FIELD));
  if (token == null || token.length === 0) {
    return undefined;
  }
  if (classifyAnthropicToken(token) === "api_key") {
    return undefined;
  }
  const denialReason = acpSpawnCredentialDenialReason(ACP_OAUTH_TOKEN_FIELD);
  if (denialReason !== undefined) {
    log.debug(
      { field: ACP_OAUTH_TOKEN_FIELD, reason: denialReason },
      "Connect Claude status: token present but spawn read would be denied",
    );
    return undefined;
  }
  if (await isAcpClaudeTokenExpiring()) {
    const boundDigest = await readBoundAccessDigest();
    if (boundDigest && boundDigest !== claudeTokenDigest(token)) {
      return token;
    }
    if (!(await hasAcpClaudeRefreshToken())) {
      return undefined;
    }
  }
  return token;
}

/**
 * Whether a conversation's raised Connect card is still something to point at.
 *
 * Two ways a card earns its place, matching the two ways one is raised. A
 * mid-run rejection leaves a marker, and the card stands while that marker
 * still names the credential a spawn would resolve. A pre-spawn failure leaves
 * no marker at all, because there was no session to record one, and its card
 * stands while there is still no usable token to spawn with.
 *
 * Asked rather than remembered, so it does not matter what made the situation
 * change. A vault write, a `config.json` edit to
 * `acp.agents.<id>.env.CLAUDE_CODE_OAUTH_TOKEN`, or a policy repair all move
 * the answer, and only one of those runs through a credential write. Hanging
 * this off the write would leave the other two stale.
 */
export async function acpConnectCardStillWarranted(
  conversationId: string,
): Promise<boolean> {
  const { conversationHasCurrentAcpMarker } =
    await import("./acp-auth-marker-store.js");
  if (await conversationHasCurrentAcpMarker(conversationId)) {
    return true;
  }
  // No marker, so this is the pre-spawn card: the failure was that a spawn
  // found nothing to authenticate with, and it stands while that is still
  // true. Asked through the spawn's own resolution rather than of the vault,
  // because a user can repair it by setting the agent's configured token, and
  // a vault-only answer would call that card warranted forever.
  const { raisedAcpConnectCardAgent } =
    await import("./acp-connect-card-state.js");
  const agentId = raisedAcpConnectCardAgent(conversationId);
  if (agentId === undefined) {
    return !(await hasAcpClaudeToken());
  }
  const { resolvedClaudeCredentialDigest } =
    await import("./prepare-agent-env.js");
  const resolved = await resolvedClaudeCredentialDigest(agentId);
  if (resolved === undefined) {
    return true;
  }
  // Resolving something is not the same as having a repair. A configured
  // token Claude already refused stands down only once the vault offers an
  // alternative, so with no replacement stored the resolver still reports it
  // and the next spawn rejects it exactly as this one did. Treating that as
  // fixed drops the card and lets a second prompt open beside it.
  const { claudeCredentialRefused } =
    await import("./acp-auth-marker-store.js");
  return claudeCredentialRefused(resolved);
}

/**
 * Persist a token set obtained by renewing an existing credential, leaving
 * the read policy exactly as it was.
 *
 * A renewal happens on a passive spawn with no user in the loop, so it must
 * not widen what the credential is allowed to do. Granting `acp_spawn` here
 * would let a background refresh restore a permission a user or admin had
 * removed from `allowedTools`.
 *
 * A rotated refresh token is written when the provider returns one. When the
 * response omits a refresh token, the stored refresh token is kept so a
 * non-rotating grant does not lose its renewal material. A missing or
 * non-positive `expiresIn` clears the recorded expiry so a stale past expiry
 * cannot condemn the new access token.
 *
 * `expectedRefreshToken` is the refresh token this request spent. If the
 * vault no longer holds that value, the access-token field is gone, or the
 * stored access token is not the one this refresh material was written
 * with, the persist is skipped so a newer token set is not overwritten and
 * a deleted or pasted credential is not replaced. Returns whether the write
 * happened.
 */
export async function persistRefreshedAcpClaudeTokens(
  tokens: AcpClaudeTokens,
  expectedRefreshToken: string,
): Promise<boolean> {
  if (!tokens.accessToken) {
    throw new Error("Refreshed Claude OAuth response had no access token.");
  }
  return withAcpClaudeTokenWrite(async () => {
    const current = await readAcpClaudeRefreshToken();
    if (current !== expectedRefreshToken) {
      log.info(
        "Skipping Claude OAuth refresh persist because the stored refresh token changed while the request was in flight",
      );
      return false;
    }
    const access = await getSecureKeyAsync(vaultKey(ACP_OAUTH_TOKEN_FIELD));
    if (access == null || access.length === 0) {
      log.info(
        "Skipping Claude OAuth refresh persist because the access token is no longer stored",
      );
      return false;
    }
    if (!(await renewalIsBoundTo(access))) {
      log.info(
        "Skipping Claude OAuth refresh persist because the stored access token is not the one this refresh material was written with",
      );
      return false;
    }
    const stored = await setSecureKeyAsync(
      vaultKey(ACP_OAUTH_TOKEN_FIELD),
      tokens.accessToken,
    );
    if (!stored) {
      throw new Error("Failed to store Claude OAuth token in secure storage.");
    }
    if (tokens.refreshToken) {
      await writeOrClear(ACP_OAUTH_REFRESH_TOKEN_FIELD, tokens.refreshToken);
    }
    const expiresAt = computeExpiresAt(tokens.expiresIn);
    await writeOrClear(
      ACP_OAUTH_EXPIRES_AT_FIELD,
      expiresAt == null ? undefined : String(expiresAt),
    );
    await writeOrClear(
      ACP_OAUTH_ACCESS_DIGEST_FIELD,
      claudeTokenDigest(tokens.accessToken),
    );
    return true;
  });
}

/**
 * The stored absolute expiry in epoch milliseconds, or null when unknown.
 *
 * Unknown is the norm for tokens connected before expiry was recorded, and is
 * treated as "assume usable": we cannot tell fresh from expired, and guessing
 * expired would refresh or discard a perfectly good token.
 */
async function readExpiresAt(): Promise<number | null> {
  const raw = await getSecureKeyAsync(vaultKey(ACP_OAUTH_EXPIRES_AT_FIELD));
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Whether the stored access token is past its recorded expiry, or close
 * enough that it should be renewed before use. False when no expiry was
 * recorded.
 */
export async function isAcpClaudeTokenExpiring(): Promise<boolean> {
  return isTokenExpired(await readExpiresAt());
}

/** The stored refresh token, or null when none was captured. */
export async function readAcpClaudeRefreshToken(): Promise<string | null> {
  const token = await getSecureKeyAsync(vaultKey(ACP_OAUTH_REFRESH_TOKEN_FIELD));
  return token != null && token.length > 0 ? token : null;
}

/** Whether renewal material is on hand, without revealing it. */
export async function hasAcpClaudeRefreshToken(): Promise<boolean> {
  return (await readAcpClaudeRefreshToken()) != null;
}

/**
 * Whether the access-token vault field is present. Presence only: not
 * whether the value is usable, expired, or readable by the spawn broker.
 *
 * Renewal spends a refresh token to replace this field. If the field is
 * gone, there is no credential to renew.
 */
export async function hasStoredAcpClaudeAccessToken(): Promise<boolean> {
  const token = await getSecureKeyAsync(vaultKey(ACP_OAUTH_TOKEN_FIELD));
  return token != null && token.length > 0;
}

async function readBoundAccessDigest(): Promise<string | null> {
  const digest = await getSecureKeyAsync(
    vaultKey(ACP_OAUTH_ACCESS_DIGEST_FIELD),
  );
  return digest != null && digest.length > 0 ? digest : null;
}

async function renewalIsBoundTo(accessToken: string): Promise<boolean> {
  const digest = await readBoundAccessDigest();
  return digest != null && digest === claudeTokenDigest(accessToken);
}

async function clearRenewalFields(): Promise<void> {
  await writeOrClear(ACP_OAUTH_REFRESH_TOKEN_FIELD, undefined);
  await writeOrClear(ACP_OAUTH_EXPIRES_AT_FIELD, undefined);
  await writeOrClear(ACP_OAUTH_ACCESS_DIGEST_FIELD, undefined);
}

/**
 * Drop the refresh token, keeping the recorded expiry and the access token.
 * Called when the provider rejects the refresh token.
 *
 * The expiry has to survive. `hasAcpClaudeToken()` reads "not connected" from
 * the combination of an expired token and no refresh token. Clearing the
 * expiry as well would make `readExpiresAt()` return null, which
 * {@link isAcpClaudeTokenExpiring} treats as "assume usable", and the dead
 * credential would report itself connected.
 */
export async function clearAcpClaudeRefreshToken(
  expectedRefreshToken?: string,
): Promise<void> {
  await withAcpClaudeTokenWrite(async () => {
    if (expectedRefreshToken !== undefined) {
      const current = await readAcpClaudeRefreshToken();
      if (current !== expectedRefreshToken) {
        log.info(
          "Skipping Claude OAuth refresh-token clear because the stored refresh token changed while the request was in flight",
        );
        return;
      }
    }
    await writeOrClear(ACP_OAUTH_REFRESH_TOKEN_FIELD, undefined);
  });
}

/**
 * Drop refresh, expiry, and the bound-access digest when they do not describe
 * the access token currently stored.
 *
 * Connect and persist write those fields as a set with the access token. A
 * later paste or CLI write replaces only the access-token field. Spending the
 * leftover refresh token would overwrite that replacement.
 */
export async function forgetAcpClaudeRenewalStateIfUnbound(): Promise<void> {
  await withAcpClaudeTokenWrite(async () => {
    const access = await getSecureKeyAsync(vaultKey(ACP_OAUTH_TOKEN_FIELD));
    const refresh = await readAcpClaudeRefreshToken();
    const expiresAt = await readExpiresAt();
    const digest = await readBoundAccessDigest();
    const hasRenewal = refresh != null || expiresAt != null || digest != null;
    if (!hasRenewal) {
      return;
    }
    if (access && digest && digest === claudeTokenDigest(access)) {
      return;
    }
    await clearRenewalFields();
  });
}

