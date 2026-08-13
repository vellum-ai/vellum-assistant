/**
 * Model-visible tool: read a conversation's recorded activity tally.
 * The file basename becomes the tool name (`turn_tally`), and the tool
 * lands in the same catalog as built-in tools.
 */

import {
  RiskLevel,
  type ToolContext,
  type ToolDefinition,
  type ToolExecutionResult,
} from "@vellumai/plugin-api";

import { type ConversationTally, getTally } from "../src/tally-store.js";

function formatTally(tally: ConversationTally): string {
  const lines = [
    `Turn tally for conversation ${tally.conversationId}:`,
    `- prompts: ${tally.prompts}`,
    `- tool uses: ${tally.toolUses}`,
  ];
  for (const entry of tally.toolBreakdown) {
    lines.push(`  - ${entry.toolName}: ${entry.uses}`);
  }
  if (tally.lastExitReason !== null) {
    lines.push(`- last turn ended: ${tally.lastExitReason}`);
  }
  return lines.join("\n");
}

const turnTally: ToolDefinition = {
  description:
    "Read the activity tally the turn-tally plugin keeps for a conversation: " +
    "how many prompts the user has sent, how many tool calls ran (per tool " +
    "when tracked), and how the last turn ended. Use when the user asks how " +
    "much activity this conversation has had.",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: {
    type: "object",
    properties: {
      conversationId: {
        type: "string",
        description:
          "Conversation to report on. Defaults to the current conversation.",
      },
    },
  },
  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const requested = input.conversationId;
    const conversationId =
      typeof requested === "string" && requested.length > 0
        ? requested
        : ctx.conversationId;
    const tally = getTally(conversationId);
    if (tally === null) {
      return {
        content: `No activity recorded yet for conversation ${conversationId}.`,
        isError: false,
      };
    }
    return { content: formatTally(tally), isError: false };
  },
};

export default turnTally;
