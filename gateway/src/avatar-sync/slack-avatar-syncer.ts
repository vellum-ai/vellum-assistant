/**
 * Syncs the assistant's avatar to the Slack bot profile via users.setPhoto.
 *
 * Requires the `users:write` bot token scope. If the scope is missing,
 * Slack returns a `missing_scope` error — logged as a warning so the user
 * can add the scope to their Slack App configuration.
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

      if (body.error === "missing_scope") {
        log.warn(
          "Slack bot token is missing the 'users:write' scope — add it " +
            "to your Slack App's bot token scopes to enable avatar sync",
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
