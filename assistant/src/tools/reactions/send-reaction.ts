import { z } from "zod";

import { conversationMessagesSyncTag } from "../../daemon/message-types/sync.js";
import { RiskLevel } from "../../permissions/types.js";
import {
  appendMessageReaction,
  getRecentUserMessages,
  type MessageReaction,
  type MessageRow,
} from "../../persistence/conversation-crud.js";
import { broadcastMessage } from "../../runtime/assistant-event-hub.js";
import { publishSyncInvalidation } from "../../runtime/sync/sync-publisher.js";
import { registerTool } from "../registry.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

const InputSchema = z.object({
  emoji: z.string().min(1),
});

// Longest legitimate emoji are ZWJ sequences (family, couple, flags with
// tags) — all comfortably under 32 UTF-16 code units. Anything longer is a
// sentence, not a reaction.
const EMOJI_MAX_LENGTH = 32;

/**
 * True when `value` is a single emoji grapheme: exactly one grapheme
 * cluster containing at least one pictographic scalar. Covers plain emoji,
 * variation-selector forms, ZWJ sequences, skin tones, keycaps, and
 * regional-indicator flags while rejecting plain text and multi-emoji
 * strings.
 */
export function isSingleEmoji(value: string): boolean {
  if (!value || value.length > EMOJI_MAX_LENGTH) {
    return false;
  }
  const segments = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      value,
    ),
  ];
  if (segments.length !== 1) {
    return false;
  }
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{20E3}/u.test(
    value,
  );
}

/**
 * True when a user-role row is a real user-authored message a reaction can
 * attach to. Skips tool_result carrier rows and daemon-injected user rows
 * (subagent/ACP/background-tool wakes, hidden scaffolding) — those are
 * transport artifacts, not something the user said.
 */
export function isReactableUserMessage(row: MessageRow): boolean {
  if (row.role !== "user") {
    return false;
  }
  if (row.metadata) {
    try {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      if (
        meta.hidden === true ||
        meta.subagentNotification !== undefined ||
        meta.acpNotification !== undefined ||
        meta.backgroundEventSource !== undefined
      ) {
        return false;
      }
    } catch {
      // Unparseable metadata never marks a row as internal.
    }
  }
  try {
    const content = JSON.parse(row.content) as unknown;
    if (Array.isArray(content)) {
      // Tool results are persisted as user rows whose blocks are all
      // `tool_result`; a reactable message carries user-authored blocks.
      return content.some((block) => {
        if (typeof block === "string") {
          return true;
        }
        const type = (block as { type?: unknown })?.type;
        return type === "text" || type === "image" || type === "document";
      });
    }
  } catch {
    // Non-JSON content is plain user text.
  }
  return true;
}

// Newest user rows scanned when resolving the reaction target. The
// triggering message is almost always within the first few rows; the cap
// only guards against a pathological run of consecutive carrier rows.
const TARGET_SCAN_LIMIT = 50;

export async function executeSendReaction(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) {
    return { content: `Invalid input: ${parsed.error.message}`, isError: true };
  }

  const emoji = parsed.data.emoji.trim();
  if (!isSingleEmoji(emoji)) {
    return {
      content:
        'The "emoji" argument must be a single Unicode emoji (e.g. "👍" or "🎉").',
      isError: true,
    };
  }

  const target = getRecentUserMessages(
    context.conversationId,
    TARGET_SCAN_LIMIT,
  ).find(isReactableUserMessage);
  if (!target) {
    return {
      content: "No user message to react to in this conversation.",
      isError: true,
    };
  }

  const reactions = appendMessageReaction(target.id, {
    emoji,
    actor: "assistant",
    createdAt: Date.now(),
  });
  if (!reactions) {
    return {
      content: "The target message no longer exists.",
      isError: true,
    };
  }

  publishMessageReactionUpdated(context.conversationId, target.id, reactions);

  return {
    content: JSON.stringify({ reacted: true, emoji, messageId: target.id }),
    isError: false,
  };
}

/**
 * Broadcast the typed `message_reaction_updated` event (full replacement
 * set, patches the row in place on live clients) plus the `sync_changed`
 * messages tag as the catch-up signal for clients that missed it. Publishes
 * via the event hub directly — the `resource-sync-events` helpers pull in
 * daemon handler modules that would cycle back into the tool manifest.
 */
function publishMessageReactionUpdated(
  conversationId: string,
  messageId: string,
  reactions: MessageReaction[],
): void {
  broadcastMessage(
    {
      type: "message_reaction_updated",
      conversationId,
      messageId,
      reactions,
    },
    conversationId,
  );
  void publishSyncInvalidation([conversationMessagesSyncTag(conversationId)]);
}

export const sendReactionTool = {
  name: "send_reaction",
  description: [
    "React to the user's latest message with a single emoji, like reacting",
    "to a message in a chat app. The reaction appears on the user's message",
    "bubble immediately and needs no accompanying text.",
    "",
    "Use it as a lightweight acknowledgment alongside (or instead of) a",
    "reply — celebrating good news, appreciating something the user shared,",
    "or acknowledging a quick confirmation. React sparingly: at most one",
    "reaction per user message, and only when it adds warmth or clarity.",
    "",
    '`emoji` must be a single standard Unicode emoji (e.g. "👍", "🎉", "❤️").',
  ].join("\n"),
  category: "interaction",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,

  input_schema: {
    type: "object",
    properties: {
      emoji: {
        type: "string",
        description:
          'A single Unicode emoji to react with (e.g. "👍", "🎉", "❤️").',
      },
    },
    required: ["emoji"],
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeSendReaction(input, context);
  },
} satisfies ToolDefinition;

registerTool(sendReactionTool);
