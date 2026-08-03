import { getMessages } from "../../persistence/conversation-crud.js";
import { extractTextFromStoredMessageContent } from "../../persistence/message-content.js";
import { TERMINAL_STATUSES } from "../../subagent/index.js";
import { invalidToolInputResult } from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import {
  resolveSubagentId,
  resolveSubagentState,
  subagentRefInputSchema,
} from "./resolve.js";

// `last_n` is deliberately UNDECLARED (loose passthrough): the executor's
// typeof-guarded read below ignores it when malformed — including non-integer
// numbers the advertised `integer` type wouldn't admit.
export const subagentReadInputSchema = subagentRefInputSchema;

/** Keys that mean the caller wants a file reader, not a subagent's output. */
const FILE_READER_KEYS = ["path", "file", "filename"] as const;

/** Misspellings of `subagent_id` seen in production traffic. */
const MISNAMED_ID_KEYS = ["subagentId", "agent_id"] as const;

/**
 * Name the wrong-tool and wrong-parameter shapes parents actually send, rather
 * than answering them with the generic '"subagent_id" or "label" is required'.
 * The input schema is loose, so these keys reach the executor instead of
 * failing validation, which is what makes the redirect possible.
 */
function misuseMessage(input: Record<string, unknown>): string | undefined {
  if (FILE_READER_KEYS.some((key) => key in input)) {
    return "subagent_read returns a subagent's output, it does not read files. Use file_read for files. Pass subagent_id or label here.";
  }
  if (MISNAMED_ID_KEYS.some((key) => key in input)) {
    return "Unknown parameter. Use subagent_id (snake_case) or label.";
  }
  return undefined;
}

export async function executeSubagentRead(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const misuse = misuseMessage(input);
  if (misuse) {
    return { content: misuse, isError: true };
  }
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
    // A premature read is often the only result a parent ever captures, so the
    // message has to close the loop itself: the completion notification is
    // already coming, and re-reading only burns another turn.
    return {
      content: `Subagent "${state.config.label}" is still ${state.status}. Do not poll: you will receive a message automatically when it completes, including its result.`,
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

  if (messageTexts.length === 0) {
    return { content: "Subagent produced no text output.", isError: false };
  }

  const lastN =
    typeof input.last_n === "number" && input.last_n > 0
      ? input.last_n
      : undefined;
  const sliced = lastN ? messageTexts.slice(-lastN) : messageTexts;

  return {
    content: sliced.join("\n\n"),
    isError: false,
  };
}
