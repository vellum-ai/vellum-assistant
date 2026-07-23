/**
 * Canonical Slack auth resolver — the single place that maps stored Slack
 * credentials to a token by the IDENTITY a call should act as. Both the
 * messaging adapter and the runtime Slack routes resolve through here, so
 * bot-vs-user identity is decided in exactly one spot.
 *
 * A Socket Mode install holds two tokens:
 *   - bot token  (xoxb-) — always present. Acts as the app ("Vex").
 *   - user token (xoxp-) — OPTIONAL. Acts as the human who installed the app.
 *
 * Which token a call uses is a question of WHO should act, not read-vs-write:
 *
 *   - "bot"  — act as the app. Used for the presence list ("which rooms is the
 *     bot in", whose `is_member` view is relative to the token's own
 *     identity), the workspace roster, and content the assistant posts as
 *     itself. Never the user token — that would answer "which rooms is the
 *     USER in", or post as the user.
 *
 *   - "user" — act as the human. Prefers the user token for its wider reach
 *     (channels the user is in but the bot isn't; `search.messages`, which
 *     only a user token can call) and for human-initiated actions (sharing).
 *     Falls back to the bot token when no user token is stored — the user
 *     token is optional, so "user" intent must always resolve to *something*
 *     when Slack is connected.
 *
 * For Socket Mode installs the resolved value is a raw token string; for legacy
 * OAuth installs it is a refreshing `OAuthConnection` (whose access_token is
 * the bot token in Slack's OAuth v2 flow). Returns `undefined` when no Slack
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

/** Which Slack identity a call should act as. See the module comment. */
export type SlackAuthIdentity = "bot" | "user";

export async function resolveSlackAuth(
  identity: SlackAuthIdentity,
  opts: { account?: string } = {},
): Promise<SlackAuth | undefined> {
  const botToken = await getSecureKeyAsync(
    credentialKey("slack_channel", "bot_token"),
  );
  if (botToken) {
    if (identity === "user") {
      // Prefer the optional user token; fall back to the bot token when the
      // install never captured one.
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
 * Run a Slack call as the user — using the user token when one is stored —
 * and fall back to the bot token when the user token can't do the job.
 *
 * Callers resolve the bot auth first (it is always present when Slack is
 * connected) and pass it as `botFallback`, so this never has to re-resolve
 * credentials or signal "not configured".
 *
 * The default fallback trigger is a 401 — the user token was revoked or
 * expired. Callers whose operation can also fail because the user token lacks
 * a required scope (e.g. a share post needs `chat:write`, which surfaces as a
 * non-401 `missing_scope`) pass a wider `shouldFallback`.
 *
 * `call` must be idempotent: on fallback it is re-run from the top with the
 * bot auth. Slack reads are safe to repeat, and a Slack write that threw
 * created nothing (the error is raised before the message is posted), so a
 * single retry cannot double-post.
 */
export async function runAsUserWithBotFallback<T>(
  botFallback: SlackAuth,
  call: (auth: SlackAuth) => Promise<T>,
  opts: {
    account?: string;
    shouldFallback?: (err: SlackApiError) => boolean;
  } = {},
): Promise<T> {
  const userAuth = (await resolveSlackAuth("user", opts)) ?? botFallback;
  const shouldFallback = opts.shouldFallback ?? ((err) => err.status === 401);
  try {
    return await call(userAuth);
  } catch (err) {
    if (
      userAuth !== botFallback &&
      err instanceof SlackApiError &&
      shouldFallback(err)
    ) {
      return call(botFallback);
    }
    throw err;
  }
}
