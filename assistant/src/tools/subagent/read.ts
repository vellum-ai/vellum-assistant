import { getMessages } from "../../persistence/conversation-crud.js";
import { extractTextFromStoredMessageContent } from "../../persistence/message-content.js";
import { getSubagentManager, TERMINAL_STATUSES } from "../../subagent/index.js";
import {
  formatSubagentToolStats,
  SUBAGENT_STATS_UNAVAILABLE,
  type SubagentState,
} from "../../subagent/types.js";
import { invalidToolInputResult } from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import {
  resolveSubagentId,
  resolveSubagentState,
  subagentRefInputSchema,
} from "./resolve.js";

/**
 * The machine truth envelope appended to a read: what the subagent actually
 * ran, so the parent can check the output above against it.
 *
 * The counters live in memory next to the manager entry, so a subagent read
 * back from its durable row (the manager's window dropped it, or the daemon
 * restarted) says they are unavailable rather than reporting zero calls, which
 * would read as "this subagent did nothing". A live entry with no stats never
 * reached the end of a run, so it has nothing measured to report.
 */
function statsFooter(subagentId: string, state: SubagentState): string {
  if (state.stats) {
    return `\n\n${formatSubagentToolStats(state.stats)}`;
  }
  if (getSubagentManager().getState(subagentId)) {
    return "";
  }
  return `\n\n${SUBAGENT_STATS_UNAVAILABLE}`;
}

// `last_n` is deliberately UNDECLARED (loose passthrough): the executor's
// typeof-guarded read below ignores it when malformed — including non-integer
// numbers the advertised `integer` type wouldn't admit.
export const subagentReadInputSchema = subagentRefInputSchema;

export async function executeSubagentRead(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = subagentReadInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("subagent_read", parsedInput.error);
  }
  const parsed = parsedInput.data;
  const subagentId = resolveSubagentId(parsed, context);
  if (!subagentId && parsed.label) {
    return {
      content: `No subagent found with label "${parsed.label}".`,
      isError: true,
    };
  }
  if (!subagentId) {
    return {
      content: '"subagent_id" or "label" is required.',
      isError: true,
    };
  }

  const state = resolveSubagentState(subagentId);
  if (!state) {
    return {
      content: `No subagent found with ID "${subagentId}".`,
      isError: true,
    };
  }

  // Ownership check: only the parent conversation can read a subagent's output.
  if (state.config.parentConversationId !== context.conversationId) {
    return {
      content: `No subagent found with ID "${subagentId}".`,
      isError: true,
    };
  }

  if (!TERMINAL_STATUSES.has(state.status)) {
    return {
      content: `Subagent "${state.config.label}" is still ${state.status}. Wait for it to finish.`,
      isError: false,
    };
  }

  // Read the subagent's conversation messages from DB.
  const dbMessages = getMessages(state.conversationId);
  if (!dbMessages || dbMessages.length === 0) {
    return {
      content: "No messages found in subagent conversation.",
      isError: true,
    };
  }

  // Extract assistant messages only - that's the subagent's output.
  // Group text blocks by message so last_n slices messages, not blocks.
  const messageTexts: string[] = [];
  for (const msg of dbMessages) {
    if (msg.role !== "assistant") {
      continue;
    }
    const blocks: string[] = [];
    try {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            blocks.push(block.text);
          }
        }
      } else if (typeof content === "string") {
        blocks.push(content);
      }
    } catch {
      blocks.push(extractTextFromStoredMessageContent(msg.content));
    }
    if (blocks.length > 0) {
      messageTexts.push(blocks.join("\n\n"));
    }
  }

  const footer = statsFooter(subagentId, state);

  if (messageTexts.length === 0) {
    return {
      content: `Subagent produced no text output.${footer}`,
      isError: false,
    };
  }

  const lastN =
    typeof input.last_n === "number" && input.last_n > 0
      ? input.last_n
      : undefined;
  const sliced = lastN ? messageTexts.slice(-lastN) : messageTexts;

  return {
    content: `${sliced.join("\n\n")}${footer}`,
    isError: false,
  };
}
