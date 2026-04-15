/**
 * Syncs the assistant's avatar to the Slack bot profile via users.setPhoto.
 *
 * NOTE: users.setPhoto is a user-token method — it requires a user token
 * (xoxp) with the `users.profile:write` scope. Bot tokens (xoxb) cannot
 * call this endpoint regardless of scopes. This implementation currently
 * uses the bot token as a placeholder; it will begin working once user
 * token support is added to the Slack channel integration.
 */

import { getLogger } from "../logger.js";
import { fetchImpl } from "../fetch.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import type { ChannelAvatarSyncer } from "./types.js";

const log = getLogger("avatar-sync:slack");

export class SlackAvatarSyncer implements ChannelAvatarSyncer {
  readonly channelName = "slack";

  constructor(private readonly credentials: CredentialCache) {}

  async sync(pngBuffer: Buffer): Promise<boolean> {
    const botToken = await this.credentials.get(
      credentialKey("slack_channel", "bot_token"),
    );
    if (!botToken) {
      log.debug("No Slack bot token available, skipping avatar sync");
      return false;
    }

    const formData = new FormData();
    formData.append(
      "image",
      new Blob([new Uint8Array(pngBuffer)], { type: "image/png" }),
      "avatar.png",
    );

    try {
      const resp = await fetchImpl("https://slack.com/api/users.setPhoto", {
        method: "POST",
        headers: { Authorization: `Bearer ${botToken}` },
        body: formData,
      });

      const body = (await resp.json()) as { ok: boolean; error?: string };

      if (body.ok) {
        log.info("Synced avatar to Slack bot profile");
        return true;
      }

      if (body.error === "missing_scope" || body.error === "not_allowed_token_type") {
        log.warn(
          "Slack avatar sync requires a user token (xoxp) with the " +
            "'users.profile:write' scope — bot tokens (xoxb) cannot call " +
            "users.setPhoto. Avatar sync will work once user token support " +
            "is added to the Slack channel integration.",
        );
      } else {
        log.warn({ error: body.error }, "Failed to sync avatar to Slack");
      }
      return false;
    } catch (err) {
      log.warn({ err }, "Failed to call Slack users.setPhoto API");
      return false;
    }
  }
}
