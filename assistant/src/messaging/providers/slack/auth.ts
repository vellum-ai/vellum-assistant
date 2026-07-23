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
 *   - "bot"  — act as the app. Used by everything reachable from the
 *     settings/control-plane surface: the presence list ("which rooms is the
 *     bot in", whose `is_member` view is relative to the token's own identity),
 *     the workspace roster, the share picker, and the share post. Those routes
 *     are exposed at the gateway with generic edge auth and the daemon never
 *     sees the calling actor's identity (the proxy swaps the caller's
 *     Authorization for a service token), so they MUST act as the neutral app
 *     identity — acting as the single stored installer `user_token` would let
 *     any caller read the installer's channels or post as them. Also used for
 *     content the assistant posts as itself.
 *
 *   - "user" — act as the assistant's owner, using the optional user token for
 *     its wider reach (channels the owner is in but the bot isn't; and
 *     `search.messages`, which only a user token can call). Scoped to the
 *     in-conversation messaging adapter, where the assistant is acting for its
 *     own owner within a trust-classified conversation — NOT the edge-reachable
 *     control-plane routes above. Falls back to the bot token when no user
 *     token is stored, so "user" always resolves to *something* when Slack is
 *     connected.
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
