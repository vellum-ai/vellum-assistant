/**
 * Slack watcher provider — polls for new DMs, mentions, and thread replies.
 *
 * Uses the conversations.history API with a timestamp watermark.
 * On first poll, captures the current time as the watermark (start from "now").
 * Subsequent polls fetch messages newer than the watermark across DM channels
 * and member channels, filtering to relevant events.
 */

import { withValidToken } from '../../security/token-manager.js';
import { truncate } from '../../util/truncate.js';
import * as slack from '../../messaging/providers/slack/client.js';
import type { WatcherProvider, WatcherItem, FetchResult } from '../provider-types.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('watcher:slack');

function messageToItem(
  msg: { ts: string; text: string; user?: string; channel: string },
  eventType: string,
  channelName: string,
): WatcherItem {
  return {
    externalId: `${msg.channel}:${msg.ts}`,
    eventType,
    summary: `Slack ${eventType.replace('slack_', '')}: ${truncate(msg.text, 100)}`,
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

export const slackProvider: WatcherProvider = {
  id: 'slack',
  displayName: 'Slack',
  requiredCredentialService: 'integration:slack',

  async getInitialWatermark(_credentialService: string): Promise<string> {
    // Start from "now" — use current epoch seconds as the timestamp watermark
    return String(Date.now() / 1000);
  },

  async fetchNew(
    credentialService: string,
    watermark: string | null,
    _config: Record<string, unknown>,
  ): Promise<FetchResult> {
    return withValidToken(credentialService, async (token) => {
      if (!watermark) {
        return { items: [], watermark: String(Date.now() / 1000) };
      }

      // Get the authenticated user's ID to detect mentions
      const authResp = await slack.authTest(token);
      const userId = authResp.user_id;

      // List DM and group DM channels to poll
      const convResp = await slack.listConversations(token, 'im,mpim', false, 100);
      const dmChannels = convResp.channels;

      const items: WatcherItem[] = [];
      let latestTs = watermark;

      // Poll each DM channel for new messages, paginating to fetch all.
      // We track a per-channel watermark candidate and only merge it into the
      // global watermark after the entire pagination loop succeeds. This prevents
      // advancing past unread messages when a later page fails (rate limit, etc.).
      for (const channel of dmChannels) {
        try {
          let channelLatestTs = watermark;
          let cursor: string | undefined;
          do {
            const histResp = await slack.conversationHistory(token, channel.id, 100, undefined, watermark, cursor);
            for (const msg of histResp.messages) {
              // Skip our own messages
              if (msg.user === userId) continue;
              // Skip messages older than watermark (shouldn't happen but guard)
              if (parseFloat(msg.ts) <= parseFloat(watermark)) continue;

              const channelName = channel.name ?? channel.user ?? channel.id;
              const eventType = channel.is_im ? 'slack_dm' : 'slack_group_dm';
              items.push(messageToItem({ ...msg, channel: channel.id }, eventType, channelName));

              if (parseFloat(msg.ts) > parseFloat(channelLatestTs)) {
                channelLatestTs = msg.ts;
              }
            }
            cursor = histResp.has_more ? histResp.response_metadata?.next_cursor : undefined;
          } while (cursor);
          // Only advance after all pages for this channel succeeded
          if (parseFloat(channelLatestTs) > parseFloat(latestTs)) {
            latestTs = channelLatestTs;
          }
        } catch (err) {
          // Skip channels we can't read (archived, permissions, etc.)
          log.debug({ channelId: channel.id, err }, 'Skipping channel in Slack watcher');
        }
      }

      // Also check a few active member channels for @mentions
      const memberConvResp = await slack.listConversations(token, 'public_channel,private_channel', true, 50);
      for (const channel of memberConvResp.channels.slice(0, 20)) {
        try {
          const histResp = await slack.conversationHistory(token, channel.id, 5, undefined, watermark);
          for (const msg of histResp.messages) {
            if (parseFloat(msg.ts) <= parseFloat(watermark)) continue;
            // Check for @mention
            if (msg.text.includes(`<@${userId}>`)) {
              items.push(messageToItem({ ...msg, channel: channel.id }, 'slack_mention', channel.name ?? channel.id));
              if (parseFloat(msg.ts) > parseFloat(latestTs)) {
                latestTs = msg.ts;
              }
            }
          }
        } catch {
          // Skip unreadable channels
        }
      }

      log.info({ count: items.length, watermark: latestTs }, 'Slack: fetched new messages');
      return { items, watermark: latestTs };
    });
  },
};
