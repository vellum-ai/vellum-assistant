/**
 * Shared Slack token resolver.
 *
 * Resolve a Slack token for the runtime Slack routes, mirroring the read/write
 * auth split in `messaging/providers/slack/adapter.ts`. Three modes:
 *
 *   - `read` — broadest visibility. For Socket Mode installs (tokens under
 *     `credential/slack_channel/*`), prefer the user OAuth token (xoxp-) when
 *     present so the share picker can surface channels the user belongs to but
 *     the bot doesn't; fall back to the bot token (xoxb-).
 *   - `write` — always the bot token, so posted messages come from the bot
 *     identity, never the user. Passing `user_token` to chat.postMessage would
 *     post as the user — unambiguously wrong.
 *   - `bot-read` — a read that must reflect the BOT's own identity. The
 *     presence list ("where is the assistant present") derives `is_member`
 *     against the token's identity, so it must use the bot token; the optional
 *     user token would report the user's channels instead of the bot's.
 *
 * For legacy OAuth installs (no Socket Mode tokens), fall back to the OAuth
 * connection's access_token, which is the bot token in Slack's OAuth v2 flow.
 */

import { getConnectionByProvider } from "../../../../oauth/oauth-store.js";
import { credentialKey } from "../../../../security/credential-key.js";
import { getSecureKeyAsync } from "../../../../security/secure-keys.js";

export async function resolveSlackToken(
  mode: "read" | "write" | "bot-read",
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
    // `write` and `bot-read` both use the bot identity's own token.
    return botToken;
  }

  const conn = getConnectionByProvider("slack");
  if (!conn) {
    return undefined;
  }
  return await getSecureKeyAsync(`oauth_connection/${conn.id}/access_token`);
}
