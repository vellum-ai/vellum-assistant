import * as slack from '../../../../messaging/providers/slack/client.js';
import type { SlackConversation } from '../../../../messaging/providers/slack/types.js';
import { getConfig } from '../../../../config/loader.js';
import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { err, ok, withSlackToken } from './shared.js';

interface ThreadSummary {
  threadTs: string;
  previewText: string;
  replyCount: number;
  participants: string[];
}

interface ChannelDigest {
  channelId: string;
  channelName: string;
  isPrivate: boolean;
  messageCount: number;
  topThreads: ThreadSummary[];
  keyParticipants: string[];
  error?: string;
}

const userNameCache = new Map<string, string>();

async function resolveUserName(token: string, userId: string): Promise<string> {
  if (!userId) return 'unknown';
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  try {
    const resp = await slack.userInfo(token, userId);
    const name = resp.user.profile?.display_name
      || resp.user.profile?.real_name
      || resp.user.real_name
      || resp.user.name;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

async function scanChannel(
  token: string,
  conv: SlackConversation,
  oldestTs: string,
  includeThreads: boolean,
): Promise<ChannelDigest> {
  const channelId = conv.id;
  const channelName = conv.name ?? channelId;
  const isPrivate = conv.is_private ?? conv.is_group ?? false;

  try {
    const history = await slack.conversationHistory(token, channelId, 100, undefined, oldestTs);
    const messages = history.messages;

    const participantIds = new Set<string>();
    for (const msg of messages) {
      if (msg.user) participantIds.add(msg.user);
    }

    const keyParticipants: string[] = [];
    for (const uid of participantIds) {
      keyParticipants.push(await resolveUserName(token, uid));
    }

    const threadMessages = messages
      .filter((m) => (m.reply_count ?? 0) > 0)
      .sort((a, b) => (b.reply_count ?? 0) - (a.reply_count ?? 0))
      .slice(0, 3);

    const topThreads: ThreadSummary[] = [];
    for (const msg of threadMessages) {
      let participants: string[] = [];

      if (includeThreads) {
        try {
          const replies = await slack.conversationReplies(token, channelId, msg.ts, 10);
          const threadParticipantIds = new Set<string>();
          for (const reply of replies.messages) {
            if (reply.user) threadParticipantIds.add(reply.user);
          }
          for (const uid of threadParticipantIds) {
            participants.push(await resolveUserName(token, uid));
          }
        } catch {
          participants = [await resolveUserName(token, msg.user ?? '')];
        }
      }

      topThreads.push({
        threadTs: msg.ts,
        previewText: truncate(msg.text, 150),
        replyCount: msg.reply_count ?? 0,
        participants,
      });
    }

    return {
      channelId,
      channelName,
      isPrivate,
      messageCount: messages.length,
      topThreads,
      keyParticipants,
    };
  } catch (e) {
    return {
      channelId,
      channelName,
      isPrivate,
      messageCount: 0,
      topThreads: [],
      keyParticipants: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const channelIds = input.channel_ids as string[] | undefined;
  const hoursBack = (input.hours_back as number) ?? 24;
  const includeThreads = (input.include_threads as boolean) ?? true;
  const maxChannels = (input.max_channels as number) ?? 20;

  try {
    return withSlackToken(async (token) => {
      const oldestTs = String((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);

      let channelsToScan: SlackConversation[];

      if (channelIds?.length) {
        const results = await Promise.allSettled(
          channelIds.map((id) => slack.conversationInfo(token, id)),
        );
        channelsToScan = results
          .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof slack.conversationInfo>>> => r.status === 'fulfilled')
          .map((r) => r.value.channel);
      } else {
        const config = getConfig();
        const preferredIds = config.skills?.entries?.slack?.config?.preferredChannels as string[] | undefined;

        if (preferredIds?.length) {
          const results = await Promise.allSettled(
            preferredIds.map((id) => slack.conversationInfo(token, id)),
          );
          channelsToScan = results
            .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof slack.conversationInfo>>> => r.status === 'fulfilled')
            .map((r) => r.value.channel);
        } else {
          const resp = await slack.listConversations(token, 'public_channel,private_channel', true, 200);
          channelsToScan = resp.channels
            .filter((c) => c.is_member)
            .sort((a, b) => {
              const aTs = a.latest?.ts ? parseFloat(a.latest.ts) : 0;
              const bTs = b.latest?.ts ? parseFloat(b.latest.ts) : 0;
              return bTs - aTs;
            })
            .slice(0, maxChannels);
        }
      }

      const scanResults = await Promise.allSettled(
        channelsToScan.map((conv) => scanChannel(token, conv, oldestTs, includeThreads)),
      );

      const digests: ChannelDigest[] = scanResults
        .filter((r): r is PromiseFulfilledResult<ChannelDigest> => r.status === 'fulfilled')
        .map((r) => r.value)
        .filter((d) => d.messageCount > 0 || d.error);

      const skippedCount = scanResults.filter((r) => r.status === 'rejected').length;

      const result = {
        scannedChannels: digests.length,
        totalChannelsAttempted: channelsToScan.length,
        skippedDueToErrors: skippedCount,
        hoursBack,
        channels: digests,
      };

      return ok(JSON.stringify(result, null, 2));
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
