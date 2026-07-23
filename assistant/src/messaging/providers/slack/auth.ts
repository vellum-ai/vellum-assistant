/**
 * Canonical Slack auth resolver — the single place that maps stored Slack
 * credentials to a token by intent. Both the messaging adapter and the
 * runtime Slack routes resolve through here, so bot-vs-user identity is
 * decided in exactly one spot.
 *
 * Intents:
 *   - `write` / `bot` — the bot identity's own token (xoxb-). Writes must post
 *     as the bot, and bot-scoped reads (e.g. the presence list's "which rooms
 *     is the bot in", whose `is_member` view is relative to the token) must
 *     see the bot's membership, never the user's.
 *   - `read` — the user OAuth token (xoxp-) when one is stored, for visibility
 *     into channels the user is in but the bot isn't (share picker, history,
 *     search). Falls back to the bot token when no user token is stored.
 *
 * For Socket Mode installs the value is a raw token string; for legacy OAuth
 * installs it is a refreshing `OAuthConnection` (its access_token is the bot
 * token in Slack's OAuth v2 flow). Returns `undefined` when no Slack
 * credentials are configured — callers map that to their own "not configured"
 * error.
 */

import type { OAuthConnection } from "../../../oauth/connection.js";
import { resolveOAuthConnection } from "../../../oauth/connection-resolver.js";
import { getConnectionByProvider } from "../../../oauth/oauth-store.js";
import { credentialKey } from "../../../security/credential-key.js";
import { getSecureKeyAsync } from "../../../security/secure-keys.js";
import { SlackApiError } from "./client.js";

export type SlackAuth = OAuthConnection | string;
export type SlackAuthIntent = "write" | "read" | "bot";

export async function resolveSlackAuth(
  intent: SlackAuthIntent,
  opts: { account?: string } = {},
): Promise<SlackAuth | undefined> {
  const botToken = await getSecureKeyAsync(
    credentialKey("slack_channel", "bot_token"),
  );
  if (botToken) {
    if (intent === "read") {
      const userToken = await getSecureKeyAsync(
        credentialKey("slack_channel", "user_token"),
      );
      return userToken ?? botToken;
    }
    return botToken;
  }

  // Legacy OAuth install: the bot identity lives in the OAuth connection's
  // access_token, resolved as a refreshing OAuthConnection. Guard on the
  // stored connection row so a missing install returns undefined instead of
  // throwing.
  if (!getConnectionByProvider("slack")) {
    return undefined;
  }
  return resolveOAuthConnection("slack", { account: opts.account });
}

/**
 * Run a read-path Slack call with the revoked-user-token fallback: try the
 * read auth (the user token when present); if Slack rejects it with a 401,
 * retry once with `botFallback`. Callers resolve the bot auth first — it is
 * always present when Slack is connected — and pass it here, so this never has
 * to re-resolve credentials or signal "not configured".
 *
 * The `call` must be idempotent: on fallback it is re-run from the top with
 * the bot auth (Slack reads are safe to repeat).
 */
export async function runSlackRead<T>(
  botFallback: SlackAuth,
  call: (auth: SlackAuth) => Promise<T>,
  opts: { account?: string } = {},
): Promise<T> {
  const readAuth = (await resolveSlackAuth("read", opts)) ?? botFallback;
  try {
    return await call(readAuth);
  } catch (err) {
    if (
      readAuth !== botFallback &&
      err instanceof SlackApiError &&
      err.status === 401
    ) {
      return call(botFallback);
    }
    throw err;
  }
}
