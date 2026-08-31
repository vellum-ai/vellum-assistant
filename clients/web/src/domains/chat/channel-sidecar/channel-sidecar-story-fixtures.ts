/**
 * Shared fixtures for the channel-sidecar stories, shaped the way production
 * shapes them.
 *
 * The web projection exposes per-message provenance only through
 * `slackMessage` (see `channel-message-provenance.ts`), so Slack is the only
 * fixture that carries entries; the non-Slack fixtures carry an identity and
 * a source link and nothing per message, which is exactly what the client can
 * derive for them. Sparse rows stay Slack-shaped too: a Slack envelope with
 * no sender, no channel name, or no timestamp is a real wire shape, not a
 * hypothetical channel.
 */

import type {
  ChannelSidecarTarget,
  ChannelTranscriptEntry,
} from "@/domains/chat/channel-sidecar/channel-sidecar-transcript";

const T0 = Date.UTC(2026, 7, 26, 14, 3, 0);

const SLACK_ARCHIVE = "https://example.slack.com/archives/C0123";

/** The thread the full-data Slack stories show. */
export const SLACK_TARGET: ChannelSidecarTarget = {
  conversationId: "conv-slack-story",
  channelId: "slack",
  threadName: "#deploys",
  sourceHref: `${SLACK_ARCHIVE}/p1712345678000200`,
};

function slackEntry({
  id,
  role,
  text,
  minute,
  senderName,
  externalMessageId,
}: {
  id: string;
  role: ChannelTranscriptEntry["role"];
  text: string;
  minute: number;
  senderName?: string;
  externalMessageId: string;
}): ChannelTranscriptEntry {
  return {
    id,
    role,
    text,
    timestamp: T0 + minute * 60_000,
    provenance: {
      channelId: "slack",
      kind: "message",
      externalMessageId,
      externalThreadId: "1712345678.000200",
      externalChatId: "C0123",
      externalChatName: "deploys",
      senderName,
      sourceLink: {
        webUrl: `${SLACK_ARCHIVE}/p${externalMessageId.replace(".", "")}`,
      },
      threadSourceLink: { webUrl: `${SLACK_ARCHIVE}/p1712345678000200` },
    },
  };
}

/** One fully-reported Slack message row, for single-row stories. */
export const SLACK_MESSAGE_ENTRY: ChannelTranscriptEntry = slackEntry({
  id: "slack-1",
  role: "user",
  text: "Deploy went red on the last step. Can someone look before the standup?",
  minute: 0,
  senderName: "Alice",
  externalMessageId: "1712345678.000200",
});

/**
 * An ordinary Slack thread: two participants, an assistant reply, and a
 * reaction event, oldest first, the way `partitionChannelTranscript` orders
 * them.
 */
export const SLACK_THREAD_ENTRIES: ChannelTranscriptEntry[] = [
  SLACK_MESSAGE_ENTRY,
  slackEntry({
    id: "slack-2",
    role: "assistant",
    text: "Looking now. The migration step timed out waiting on the advisory lock; retrying once the nightly backfill job releases it.",
    minute: 2,
    senderName: "Vellum",
    externalMessageId: "1712345800.000300",
  }),
  slackEntry({
    id: "slack-3",
    role: "user",
    text: "Thanks. Ping here when it clears, and drop the failing step's log link if you have it.",
    minute: 3,
    senderName: "Bob",
    externalMessageId: "1712345860.000400",
  }),
  reactionEntry(),
];

/** The reaction row of {@link SLACK_THREAD_ENTRIES}: an event, not content. */
function reactionEntry(): ChannelTranscriptEntry {
  const base = slackEntry({
    id: "slack-4",
    role: "user",
    text: "",
    minute: 5,
    senderName: "Alice",
    externalMessageId: "1712345980.000500",
  });
  return {
    ...base,
    provenance: {
      ...base.provenance,
      kind: "reaction",
      reaction: { emoji: "tada", op: "added", actorName: "Alice" },
    },
  };
}

/**
 * Slack rows with the optional provenance fields absent (no sender, no
 * timestamp) and a long pasted body, which the drawer renders in full. Each
 * is a shape Slack can genuinely produce, so the rows exercise degradation
 * and wrapping, not error handling.
 */
export const SLACK_SPARSE_ENTRIES: ChannelTranscriptEntry[] = [
  {
    id: "sparse-1",
    role: "user",
    text: "Message from a sender Slack reported nothing about.",
    timestamp: undefined,
    provenance: {
      channelId: "slack",
      kind: "message",
      externalMessageId: "1712346000.000600",
      externalChatId: "C0123",
    },
  },
  {
    id: "sparse-2",
    role: "user",
    text: "Long context pasted into the thread, rendered in full because the drawer is the canonical home of the rows it holds. ".repeat(6).trimEnd(),
    timestamp: T0 + 6 * 60_000,
    provenance: {
      channelId: "slack",
      kind: "message",
      externalMessageId: "1712346060.000700",
      externalChatId: "C0123",
      senderName: "Alice",
    },
  },
];

/**
 * A Discord-bound conversation. Discord has no per-row envelope on the wire,
 * so its drawer has an identity and a way back to the source and no rows:
 * the empty-detail fallback every envelope-less channel gets.
 */
export const DISCORD_TARGET: ChannelSidecarTarget = {
  conversationId: "conv-discord-story",
  channelId: "discord",
  threadName: "help-desk",
  sourceHref: "https://discord.com/channels/100200300/400500600",
};
