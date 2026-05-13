/**
 * Shared Slack token resolver.
 *
 * Resolve a Slack token for the Share UI, mirroring the read/write auth split
 * in `messaging/providers/slack/adapter.ts`.
 *
 * For Socket Mode installs (tokens stored under `credential/slack_channel/*`),
 * prefer the user OAuth token (xoxp-) for reads when present — this lets the
 * channel picker surface channels the user belongs to but the bot doesn't.
 * Fall back to the bot token (xoxb-) otherwise.
 *
 * Writes MUST always use the bot token so posted messages come from the bot
 * identity, never the user. Passing `user_token` to chat.postMessage would
 * post as the user — unambiguously wrong for Share UI behavior.
 *
 * For legacy OAuth installs (no Socket Mode tokens), fall back to the OAuth
 * connection's access_token, which is the bot token in Slack's OAuth v2 flow.
 */

import { getConnectionByProvider } from "../../../../oauth/oauth-store.js";
import { credentialKey } from "../../../../security/credential-key.js";
import { getSecureKeyAsync } from "../../../../security/secure-keys.js";

export async function resolveSlackToken(
  mode: "read" | "write",
): Promise<string | undefined> {
  const botToken = await getSecureKeyAsync(
    credentialKey("slack_channel", "bot_token"),
  );
  if (botToken) {
    if (mode === "read") {
      const userToken = await getSecureKeyAsync(
        credentialKey("slack_channel", "user_token"),
      );
      return userToken ?? botToken;
    }
    return botToken;
  }

  const conn = getConnectionByProvider("slack");
  if (!conn) return undefined;
  return await getSecureKeyAsync(`oauth_connection/${conn.id}/access_token`);
}
