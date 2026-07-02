import { z } from "zod";

import { RiskLevel } from "../../permissions/types.js";
import {
  appendMessageReaction,
  getRecentUserMessages,
  type MessageRow,
} from "../../persistence/conversation-crud.js";
import { publishMessageReactionUpdated } from "../../runtime/sync/message-reaction-events.js";
import { isSingleEmoji } from "../../util/emoji.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

const InputSchema = z.object({
  emoji: z.string().min(1),
});

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
        return (
          type === "text" ||
          type === "image" ||
          type === "document" ||
          type === "file"
        );
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

export const sendReactionTool = {
  name: "send_reaction",
  description: [
    "React to the user's latest message with a single emoji, like reacting",
    "to a message in a chat app. The reaction appears on the user's message",
    "bubble immediately and needs no accompanying text.",
    "",
    "Use it as a lightweight acknowledgment alongside (or instead of) a",
    "reply — celebrating good news, appreciating something the user shared,",
    "or acknowledging a quick confirmation. React frequently when it fits",
    "the vibe — max one per message, and don't force it if nothing lands.",
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
