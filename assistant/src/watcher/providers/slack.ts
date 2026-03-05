/**
 * Slack watcher provider — polls for new DMs, mentions, and channel messages.
 *
 * Uses the conversations.history API with a timestamp watermark.
 * On first poll, captures the current time as the watermark (start from "now").
 * Subsequent polls fetch messages newer than the watermark across configured
 * channels, DM channels, and member channels.
 */

import * as slack from "../../messaging/providers/slack/client.js";
import { withValidToken } from "../../security/token-manager.js";
import { getLogger } from "../../util/logger.js";
import { truncate } from "../../util/truncate.js";
import type {
  FetchResult,
  WatcherItem,
  WatcherProvider,
} from "../provider-types.js";

const log = getLogger("watcher:slack");

/**
 * Provider-specific configuration for the Slack watcher.
 *
 * When `channels` is specified, those channels are monitored for ALL messages
 * (not just mentions). When omitted or empty, the legacy behavior applies:
 * @mentions in the top 20 member channels.
 *
 * ## Socket Mode Redundancy
 *
 * When the gateway is running with Socket Mode enabled, it already receives
 * real-time events for @mentions, DMs, and active thread replies. The watcher's
 * polling is therefore redundant for those event types. Set
 * `socketModeActive: true` to skip polling for DMs and @mentions that Socket
 * Mode already covers. The watcher will still poll for configured `channels`
 * (all-message monitoring) since Socket Mode only forwards messages where the
 * bot is mentioned or in active threads.
 *
 * @deprecated The polling-based watcher for DMs and @mentions is superseded by
 * Socket Mode in the gateway. Once Socket Mode is confirmed stable, the DM and
 * mention-polling code paths can be removed entirely.
 */
interface SlackWatcherConfig {
  /** Channel IDs to watch for all messages (e.g. ["C01234ABCDE"]).
   *  When non-empty, replaces the default "top 20 member channels for mentions" behavior. */
  channels?: string[];
  /** When true, also monitor DMs and group DMs (default: true). */
  includeDMs?: boolean;
  /**
   * When true, skip polling for DMs and @mentions since the gateway's Socket
   * Mode connection already delivers those events in real-time. The watcher
   * will still poll explicitly configured `channels` for all-message monitoring.
   */
  socketModeActive?: boolean;
}

function messageToItem(
  msg: { ts: string; text: string; user?: string; channel: string },
  eventType: string,
  channelName: string,
): WatcherItem {
  return {
    externalId: `${msg.channel}:${msg.ts}`,
    eventType,
    summary: `Slack ${eventType.replace("slack_", "")}: ${truncate(
      msg.text,
      100,
    )}`,
    payload: {
      channel: msg.channel,
      channelName,
      ts: msg.ts,
      user: msg.user,
      text: msg.text,
    },
    timestamp: parseFloat(msg.ts) * 1000,
  };
}

/**
 * Poll a single channel for new messages since the watermark, paginating
 * through all results. Returns items and the latest timestamp seen.
 */
async function pollChannel(
  token: string,
  channelId: string,
  channelName: string,
  eventType: string,
  watermark: string,
  userId: string,
): Promise<{ items: WatcherItem[]; latestTs: string }> {
  const items: WatcherItem[] = [];
  let channelLatestTs = watermark;
  let cursor: string | undefined;

  do {
    const histResp = await slack.conversationHistory(
      token,
      channelId,
      100,
      undefined,
      watermark,
      cursor,
    );
    for (const msg of histResp.messages) {
      if (msg.user === userId) continue;
      if (parseFloat(msg.ts) <= parseFloat(watermark)) continue;

      items.push(
        messageToItem({ ...msg, channel: channelId }, eventType, channelName),
      );

      if (parseFloat(msg.ts) > parseFloat(channelLatestTs)) {
        channelLatestTs = msg.ts;
      }
    }
    cursor = histResp.has_more
      ? histResp.response_metadata?.next_cursor
      : undefined;
  } while (cursor);

  return { items, latestTs: channelLatestTs };
}

export const slackProvider: WatcherProvider = {
  id: "slack",
  displayName: "Slack",
  requiredCredentialService: "integration:slack",

  async getInitialWatermark(_credentialService: string): Promise<string> {
    // Start from "now" — use current epoch seconds as the timestamp watermark
    return String(Date.now() / 1000);
  },

  async fetchNew(
    credentialService: string,
    watermark: string | null,
    config: Record<string, unknown>,
    _watcherKey: string,
  ): Promise<FetchResult> {
    return withValidToken(credentialService, async (token) => {
      if (!watermark) {
        return { items: [], watermark: String(Date.now() / 1000) };
      }

      const slackConfig = config as SlackWatcherConfig;

      // Normalize channels: config is persisted as untyped JSON, so a caller
      // could provide a bare string instead of an array. Coerce to string[]
      // and filter out any non-string entries to prevent iterating characters.
      const rawChannels = slackConfig.channels;
      const watchChannels: string[] = (
        Array.isArray(rawChannels)
          ? rawChannels.filter((ch): ch is string => typeof ch === "string")
          : typeof rawChannels === "string"
            ? [rawChannels]
            : []
      ).filter((ch) => ch.trim().length > 0);

      const includeDMs =
        typeof slackConfig.includeDMs === "boolean"
          ? slackConfig.includeDMs
          : true;

      const socketModeActive = slackConfig.socketModeActive === true;
      if (socketModeActive) {
        log.info(
          "Socket Mode active — skipping DM and @mention polling (handled by gateway)",
        );
      }

      const authResp = await slack.authTest(token);
      const userId = authResp.user_id;

      const items: WatcherItem[] = [];
      let latestTs = watermark;

      // ── DM / Group DM polling ──────────────────────────────────────
      // Skip when Socket Mode is active — the gateway already delivers DM events in real-time.
      if (includeDMs && !socketModeActive) {
        const convResp = await slack.listConversations(
          token,
          "im,mpim",
          false,
          100,
        );
        for (const channel of convResp.channels) {
          try {
            const channelName = channel.name ?? channel.user ?? channel.id;
            const eventType = channel.is_im ? "slack_dm" : "slack_group_dm";
            const result = await pollChannel(
              token,
              channel.id,
              channelName,
              eventType,
              watermark,
              userId,
            );
            items.push(...result.items);
            if (parseFloat(result.latestTs) > parseFloat(latestTs)) {
              latestTs = result.latestTs;
            }
          } catch (err) {
            log.debug(
              { channelId: channel.id, err },
              "Skipping channel in Slack watcher",
            );
          }
        }
      }

      // ── Configured channel polling (all messages) ──────────────────
      if (watchChannels.length > 0) {
        for (const channelId of watchChannels) {
          try {
            const result = await pollChannel(
              token,
              channelId,
              channelId,
              "slack_channel_message",
              watermark,
              userId,
            );
            items.push(...result.items);
            if (parseFloat(result.latestTs) > parseFloat(latestTs)) {
              latestTs = result.latestTs;
            }
          } catch (err) {
            log.debug(
              { channelId, err },
              "Skipping configured channel in Slack watcher",
            );
          }
        }
      } else if (!socketModeActive) {
        // Legacy behavior: check top 20 member channels for @mentions only.
        // Skipped when Socket Mode is active — the gateway already delivers
        // app_mention events in real-time.
        const memberConvResp = await slack.listConversations(
          token,
          "public_channel,private_channel",
          true,
          50,
        );
        for (const channel of memberConvResp.channels.slice(0, 20)) {
          try {
            const histResp = await slack.conversationHistory(
              token,
              channel.id,
              5,
              undefined,
              watermark,
            );
            for (const msg of histResp.messages) {
              if (parseFloat(msg.ts) <= parseFloat(watermark)) continue;
              if (msg.text.includes(`<@${userId}>`)) {
                items.push(
                  messageToItem(
                    { ...msg, channel: channel.id },
                    "slack_mention",
                    channel.name ?? channel.id,
                  ),
                );
                if (parseFloat(msg.ts) > parseFloat(latestTs)) {
                  latestTs = msg.ts;
                }
              }
            }
          } catch {
            // Skip unreadable channels
          }
        }
      }

      log.info(
        { count: items.length, watermark: latestTs },
        "Slack: fetched new messages",
      );
      return { items, watermark: latestTs };
    });
  },
};
