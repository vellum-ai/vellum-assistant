import { getConfig } from "../../../../config/loader.js";
import * as slack from "../../../../messaging/providers/slack/client.js";
import type { SlackConversation } from "../../../../messaging/providers/slack/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok, withSlackToken } from "./shared.js";

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
  if (!userId) return "unknown";
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  try {
    const resp = await slack.userInfo(token, userId);
    const name =
      resp.user.profile?.display_name ||
      resp.user.profile?.real_name ||
      resp.user.real_name ||
      resp.user.name;
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
    const history = await slack.conversationHistory(
      token,
      channelId,
      100,
      undefined,
      oldestTs,
    );
    const messages = history.messages;

    const participantIds = new Set<string>();
    for (const msg of messages) {
      if (msg.user) participantIds.add(msg.user);
    }

    const keyParticipants = await Promise.all(
      [...participantIds].map((uid) => resolveUserName(token, uid)),
    );

    const threadMessages = messages
      .filter((m) => (m.reply_count ?? 0) > 0)
      .sort((a, b) => (b.reply_count ?? 0) - (a.reply_count ?? 0))
      .slice(0, 3);

    const topThreads: ThreadSummary[] = await Promise.all(
      threadMessages.map(async (msg) => {
        let participants: string[] = [];

        if (includeThreads) {
          try {
            const replies = await slack.conversationReplies(
              token,
              channelId,
              msg.ts,
              10,
            );
            const threadParticipantIds = new Set<string>();
            for (const reply of replies.messages) {
              if (reply.user) threadParticipantIds.add(reply.user);
            }
            participants = await Promise.all(
              [...threadParticipantIds].map((uid) =>
                resolveUserName(token, uid),
              ),
            );
          } catch {
            participants = [await resolveUserName(token, msg.user ?? "")];
          }
        }

        return {
          threadTs: msg.ts,
          previewText: truncate(msg.text, 150),
          replyCount: msg.reply_count ?? 0,
          participants,
        };
      }),
    );

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
  return text.slice(0, maxLen - 3) + "...";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BlockKitBlock = Record<string, any>;

/**
 * Build Slack Block Kit blocks from digest results.
 * Produces a structured Block Kit payload with header, per-channel sections,
 * thread context blocks, and dividers.
 */
function buildBlockKitOutput(
  digests: ChannelDigest[],
  hoursBack: number,
  totalAttempted: number,
  skippedCount: number,
): BlockKitBlock[] {
  const blocks: BlockKitBlock[] = [];

  // Header block with scan summary
  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `Slack Digest — ${digests.length} channel${digests.length !== 1 ? "s" : ""} scanned`,
    },
  });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Time range:* Last ${hoursBack} hour${hoursBack !== 1 ? "s" : ""} | *Channels attempted:* ${totalAttempted} | *Skipped:* ${skippedCount}`,
    },
  });

  blocks.push({ type: "divider" });

  for (const digest of digests) {
    if (digest.error) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${digest.isPrivate ? "\ud83d\udd12 " : ""}*#${digest.channelName}* — _Error: ${digest.error}_`,
        },
      });
      blocks.push({ type: "divider" });
      continue;
    }

    // Channel section with name, message count, privacy indicator
    const privacyIcon = digest.isPrivate ? "\ud83d\udd12 " : "";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${privacyIcon}*#${digest.channelName}* — ${digest.messageCount} message${digest.messageCount !== 1 ? "s" : ""}`,
      },
    });

    // Key participants as context
    if (digest.keyParticipants.length > 0) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*Active:* ${digest.keyParticipants.join(", ")}`,
          },
        ],
      });
    }

    // Thread previews as context blocks
    for (const thread of digest.topThreads) {
      const participantText =
        thread.participants.length > 0
          ? thread.participants.join(", ")
          : "unknown";
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `\ud83e\uddf5 *${thread.replyCount} replies* (${participantText}): ${thread.previewText}`,
          },
        ],
      });
    }

    blocks.push({ type: "divider" });
  }

  // Slack Block Kit enforces a 50-block maximum per message.
  // Truncate and append a summary block when we exceed the limit.
  const SLACK_BLOCK_LIMIT = 50;
  if (blocks.length > SLACK_BLOCK_LIMIT) {
    const overflow = blocks.length - (SLACK_BLOCK_LIMIT - 1);
    blocks.length = SLACK_BLOCK_LIMIT - 1;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `_... and ${overflow} more block${overflow !== 1 ? "s" : ""} truncated (some channels omitted). Use \`channel_ids\` to drill into specific channels._`,
      },
    });
  }

  return blocks;
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const channelIds = input.channel_ids as string[] | undefined;
  const hoursBack = (input.hours_back as number) ?? 24;
  const includeThreads = (input.include_threads as boolean) ?? true;
  const maxChannels = (input.max_channels as number) ?? 20;
  const format = (input.format as string) ?? "text";

  try {
    return await withSlackToken(async (token) => {
      const oldestTs = String((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);

      let channelsToScan: SlackConversation[];
      let failedLookups = 0;

      if (channelIds?.length) {
        const results = await Promise.allSettled(
          channelIds.map((id) => slack.conversationInfo(token, id)),
        );
        channelsToScan = results
          .filter(
            (
              r,
            ): r is PromiseFulfilledResult<
              Awaited<ReturnType<typeof slack.conversationInfo>>
            > => r.status === "fulfilled",
          )
          .map((r) => r.value.channel);
        failedLookups = results.filter((r) => r.status === "rejected").length;
      } else {
        const config = getConfig();
        const preferredIds = config.skills?.entries?.slack?.config
          ?.preferredChannels as string[] | undefined;

        if (preferredIds?.length) {
          const results = await Promise.allSettled(
            preferredIds.map((id) => slack.conversationInfo(token, id)),
          );
          channelsToScan = results
            .filter(
              (
                r,
              ): r is PromiseFulfilledResult<
                Awaited<ReturnType<typeof slack.conversationInfo>>
              > => r.status === "fulfilled",
            )
            .map((r) => r.value.channel);
          failedLookups = results.filter((r) => r.status === "rejected").length;
        } else {
          const allChannels: SlackConversation[] = [];
          let cursor: string | undefined;
          do {
            const resp = await slack.listConversations(
              token,
              "public_channel,private_channel",
              true,
              200,
              cursor,
            );
            allChannels.push(...resp.channels);
            cursor = resp.response_metadata?.next_cursor || undefined;
          } while (cursor);

          channelsToScan = allChannels
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
        channelsToScan.map((conv) =>
          scanChannel(token, conv, oldestTs, includeThreads),
        ),
      );

      const digests: ChannelDigest[] = scanResults
        .filter(
          (r): r is PromiseFulfilledResult<ChannelDigest> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value)
        .filter((d) => d.messageCount > 0 || d.error);

      const skippedCount = scanResults.filter(
        (r) => r.status === "rejected",
      ).length;

      if (format === "blocks") {
        const blocks = buildBlockKitOutput(
          digests,
          hoursBack,
          channelsToScan.length,
          skippedCount,
        );
        return ok(JSON.stringify({ blocks }, null, 2));
      }

      const result = {
        scannedChannels: digests.length,
        totalChannelsAttempted: channelsToScan.length,
        skippedDueToErrors: skippedCount,
        failedLookups,
        hoursBack,
        channels: digests,
      };

      return ok(JSON.stringify(result, null, 2));
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
