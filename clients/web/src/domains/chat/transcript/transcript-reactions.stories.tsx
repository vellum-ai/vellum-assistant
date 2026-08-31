import type { ReactNode } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";

import { Transcript } from "./transcript";
import type { TranscriptItem } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
//
// A reaction row arrives from the wire as a message whose stored body is the
// "[reaction]" sentinel plus a `reaction` fact; the transcript renders the
// fact and never the sentinel. Inbound reactions (a person reacting on the
// channel) persist as `user` rows carrying `actorDisplayName`; the
// assistant's own persist as `assistant` rows with `selfAuthored`. Slack
// reaction rows additionally carry their `slackMessage` envelope with
// `eventKind: "reaction"`, and Slack-aware rendering prefers that richer
// line. `textBody` is the canonical single-text-block builder the ingest
// boundary produces.
// ---------------------------------------------------------------------------

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
): TranscriptItem {
  const msg: DisplayMessage = { id, role, ...textBody(text) };
  return { kind: "message", key: id, message: msg };
}

function reactionRow(
  id: string,
  role: "user" | "assistant",
  reaction: NonNullable<DisplayMessage["reaction"]>,
): TranscriptItem {
  const msg: DisplayMessage = {
    id,
    role,
    ...textBody("[reaction]"),
    reaction,
  };
  return { kind: "message", key: id, message: msg };
}

const REACTION_LINES: TranscriptItem[] = [
  message("m1", "user", "Shipped the release notes, take a look when you can."),
  message(
    "m2",
    "assistant",
    "Read through them. The migration section is clear, and the rollback note covers the flag flip.",
  ),
  reactionRow("r1", "user", {
    emoji: "heart",
    op: "added",
    targetMessageId: "m2",
    actorDisplayName: "Alice",
  }),
  reactionRow("r2", "assistant", {
    emoji: "🎉",
    op: "added",
    targetMessageId: "m1",
    selfAuthored: true,
  }),
  reactionRow("r3", "user", {
    emoji: "+1",
    op: "added",
    targetMessageId: "m2",
  }),
  reactionRow("r4", "user", {
    emoji: "heart",
    op: "removed",
    targetMessageId: "m2",
    actorDisplayName: "Alice",
  }),
];

// Every emoji form a channel can deliver: a unicode emoji renders as itself,
// a shortcode resolves through the emoji catalog (":shortcode:" while it
// lazy-loads), and a Discord custom-emoji mention renders as its bare
// ":name:" without consulting the catalog, even when the name collides with
// a catalog shortcode, so a guild emoji never swaps into an unrelated
// standard emoji.
const EMOJI_RESOLUTION: TranscriptItem[] = [
  message("m1", "assistant", "Deployed. Watching the error rates now."),
  reactionRow("e1", "user", {
    emoji: "🎉",
    op: "added",
    targetMessageId: "m1",
    actorDisplayName: "Unicode",
  }),
  reactionRow("e2", "user", {
    emoji: "tada",
    op: "added",
    targetMessageId: "m1",
    actorDisplayName: "Shortcode",
  }),
  reactionRow("e3", "user", {
    emoji: "<:vex:12345>",
    op: "added",
    targetMessageId: "m1",
    actorDisplayName: "Custom guild emoji",
  }),
  reactionRow("e4", "user", {
    emoji: "<:heart:99>",
    op: "added",
    targetMessageId: "m1",
    actorDisplayName: "Custom emoji named like a shortcode",
  }),
];

function slackReactionRow(
  id: string,
  reaction: {
    emoji: string;
    op: "added" | "removed";
    actorDisplayName?: string;
    targetChannelTs: string;
  },
): TranscriptItem {
  const msg: DisplayMessage = {
    id,
    role: "user",
    ...textBody("[reaction]"),
    reaction: {
      emoji: reaction.emoji,
      op: reaction.op,
      targetMessageId: reaction.targetChannelTs,
      actorDisplayName: reaction.actorDisplayName,
    },
    slackMessage: {
      channelId: "C042MSGCHAN",
      channelName: "release-crew",
      channelTs: `${id}.000100`,
      eventKind: "reaction",
      reaction,
    },
  };
  return { kind: "message", key: id, message: msg };
}

const SLACK_SHAPED: TranscriptItem[] = [
  message("s1", "user", "Staging bake looks clean, cutting the release."),
  message("s2", "assistant", "Tag is up and the production run is dispatched."),
  slackReactionRow("sr1", {
    emoji: "raised_hands",
    op: "added",
    actorDisplayName: "Ben",
    targetChannelTs: "1725100000.000200",
  }),
  slackReactionRow("sr2", {
    emoji: "raised_hands",
    op: "removed",
    actorDisplayName: "Ben",
    targetChannelTs: "1725100000.000200",
  }),
];

/** A sized chat surface; `Transcript` fills its `h-full` parent. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        height: 560,
        width: 780,
        overflow: "hidden",
        borderRadius: 12,
        border: "1px solid var(--border-base)",
        background: "var(--surface-base)",
      }}
    >
      {children}
    </div>
  );
}

/**
 * Reaction rows in the main transcript, on every channel. A reaction row
 * renders as a quiet italic line built from its projected fact, never the
 * stored "[reaction]" sentinel: the assistant's own reactions read
 * "Reacted with ...", another actor's lead with the actor's name (falling
 * back to "Someone"), and a removal names the withdrawn emoji. Slack rows
 * keep their richer Slack transcript line instead.
 */
const meta: Meta<typeof Transcript> = {
  title: "Chat/TranscriptReactions",
  component: Transcript,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    conversationId: "demo",
    onSurfaceAction: () => {},
  },
  decorators: [
    (Story) => (
      <Frame>
        <Story />
      </Frame>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Transcript>;

/**
 * Both directions and both operations around an ordinary exchange: an
 * inbound reaction with a named actor, the assistant's own (`selfAuthored`,
 * no actor name), an inbound one with no actor (the "Someone" fallback,
 * with its `+1` shortcode resolved through the catalog), and a removal.
 */
export const ReactionLines: Story = {
  args: { items: REACTION_LINES },
};

/**
 * The emoji-resolution matrix of `displayReactionEmoji`: unicode passes
 * through, a shortcode resolves through the lazy-loaded catalog, and a
 * Discord custom-emoji mention renders as its bare ":name:" even when the
 * name collides with a catalog shortcode ("heart" here), keeping the guild
 * emoji's identity instead of swapping in the standard emoji.
 */
export const EmojiResolution: Story = {
  args: { items: EMOJI_RESOLUTION },
};

/**
 * Slack reaction rows carry their `slackMessage` envelope
 * (`eventKind: "reaction"`), so the transcript renders the richer Slack
 * line (emoji, actor, verb) instead of the neutral italic reaction line.
 */
export const SlackShaped: Story = {
  args: { items: SLACK_SHAPED },
};
