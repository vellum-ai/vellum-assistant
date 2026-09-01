/**
 * `react_to_message`: the assistant reacts with an emoji on the current
 * channel conversation.
 *
 * The producer half of the transport's `react` capability: the tool surface
 * only offers this when the turn's channel transport implements `react`
 * (`isToolActiveForContext` gates on `supportsChannelReaction`), so the
 * model never sees the option on a channel that cannot honor it.
 *
 * The default target is the message that triggered the turn, which is the
 * one id every channel turn carries (`ToolContext.sourceMessageId`); an
 * explicit `messageId` in the channel's own id space overrides it for
 * callers that hold one (a skill working from platform APIs).
 */
import { z } from "zod";

import { parseChannelId } from "../../channels/types.js";
import { findConversationOrSubagent } from "../../daemon/conversation-registry.js";
import { persistReactionRecords } from "../../daemon/reaction-record.js";
import {
  sendChannelReaction,
  supportsChannelReaction,
} from "../../messaging/providers/index.js";
import { RiskLevel } from "../../permissions/types.js";
import {
  invalidToolInputResult,
  toToolInputSchema,
} from "../shared/zod-tool-schema.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

export const reactToMessageInputSchema = z.looseObject({
  emoji: z
    .string()
    .min(1)
    .describe(
      "The emoji, in this channel's own form: a Slack emoji name like " +
        "thumbsup (colons optional), a unicode emoji on other channels.",
    ),
  action: z
    .enum(["add", "remove"])
    .describe("Add the reaction (default) or remove one you added earlier.")
    .optional()
    .catch(undefined),
  messageId: z
    .string()
    .min(1)
    .describe(
      "Target message id in the channel's own id space. Omit to react to " +
        "the message that started this turn, which is the usual case.",
    )
    .optional()
    .catch(undefined),
});

const DESCRIPTION =
  "React with an emoji on the current channel conversation, the way a " +
  "person would tap a reaction instead of writing a reply. By default the " +
  "reaction lands on the message that started this turn. Use it to " +
  "acknowledge without adding a message; it does not replace answering " +
  "when an answer is called for. When the reaction is your whole reply, " +
  "output exactly <no_response/> afterward so no message is posted.";

export const reactToMessageTool = {
  name: "react_to_message",
  description: DESCRIPTION,
  category: "interaction",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: toToolInputSchema(reactToMessageInputSchema),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = reactToMessageInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("react_to_message", parsed.error);
    }

    const channel = context.executionChannel;
    const chatId = context.requesterChatId;
    const messageId = parsed.data.messageId ?? context.sourceMessageId;
    if (!channel || !chatId || !messageId) {
      return {
        content:
          "Reactions are only available in a channel conversation with a " +
          "message to react to; this turn has no channel message context.",
        isError: true,
      };
    }
    if (!supportsChannelReaction(channel)) {
      return {
        content: `The ${channel} channel does not support reactions.`,
        isError: true,
      };
    }

    const action = parsed.data.action ?? "add";
    // The turn's thread coordinate belongs only to the turn's own message;
    // an explicit messageId may live elsewhere, so it travels bare.
    const threadId =
      parsed.data.messageId === undefined ? context.sourceThreadId : undefined;
    const result = await sendChannelReaction(channel, {
      chatId,
      messageId,
      ...(threadId ? { threadId } : {}),
      emoji: parsed.data.emoji,
      action,
    });
    if (!result.ok) {
      return {
        content:
          `Could not ${action} the ${parsed.data.emoji} reaction; the ` +
          "channel rejected it.",
        isError: true,
      };
    }

    // The delivered reaction becomes a durable row, the same canonical
    // fact inbound reactions store. Queued on the live conversation and
    // drained by the agent loop at the turn boundary, never written here:
    // an assistant row inserted between this call's tool_use and its
    // tool_result would break the pairing history repair enforces, and a
    // reload would read the reaction as having failed. The rare turn with
    // no resident conversation persists directly, trading perfect row
    // ordering for durability.
    const sourceChannel = parseChannelId(channel);
    if (sourceChannel) {
      const record = {
        channel: sourceChannel,
        chatId,
        messageId,
        emoji: parsed.data.emoji,
        op: action === "remove" ? ("removed" as const) : ("added" as const),
        ...(context.trustClass
          ? { provenanceTrustClass: context.trustClass }
          : {}),
      };
      const conversation = findConversationOrSubagent(context.conversationId);
      if (conversation) {
        conversation.queueReactionRecord(record);
      } else {
        await persistReactionRecords(context.conversationId, [record]);
      }
    }

    return {
      content:
        action === "remove"
          ? `Removed the ${parsed.data.emoji} reaction.`
          : `Reacted with ${parsed.data.emoji}.`,
      isError: false,
    };
  },
} satisfies ToolDefinition;
