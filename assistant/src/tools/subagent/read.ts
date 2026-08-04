import { getMessages } from "../../persistence/conversation-crud.js";
import { extractTextFromStoredMessageContent } from "../../persistence/message-content.js";
import { getSubagentManager, TERMINAL_STATUSES } from "../../subagent/index.js";
import {
  formatSubagentToolStats,
  SUBAGENT_READ_STILL_PROCESSING,
  SUBAGENT_STATS_UNAVAILABLE,
} from "../../subagent/types.js";
import { bundledToolInputMisuseMessage } from "../shared/input-misuse.js";
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
 * The counters are re-read first, because a child that was sent guidance keeps
 * running after the harvest its own run took. `settled` is false when that
 * guidance is still being processed, which makes both the transcript above and
 * these counts an interim reading, so the footer says so.
 *
 * The manager owns the whole answer, including why there are no counters: they
 * live in memory only, so a subagent rebuilt from its durable row says they are
 * unavailable rather than reporting zero calls, which would read as "this
 * subagent did nothing", while a live run that never reached its harvest has
 * nothing measured to report and claims nothing.
 */
function statsFooter(subagentId: string, settled: boolean): string {
  const note = settled ? "" : `\n\n${SUBAGENT_READ_STILL_PROCESSING}`;
  const reading = getSubagentManager().currentToolStats(subagentId);
  switch (reading.kind) {
    case "counted":
      return `${note}\n\n${formatSubagentToolStats(reading.stats)}`;
    case "unrecoverable":
      return `${note}\n\n${SUBAGENT_STATS_UNAVAILABLE}`;
    default:
      return note;
  }
}

// `last_n` is deliberately UNDECLARED (loose passthrough): the executor's
// typeof-guarded read below ignores it when malformed — including non-integer
// numbers the advertised `integer` type wouldn't admit.
export const subagentReadInputSchema = subagentRefInputSchema;

export async function executeSubagentRead(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  // File-reader keys and misspellings of `subagent_id` name a wrong-tool or
  // wrong-parameter call, so they get the redirect rather than the generic
  // '"subagent_id" or "label" is required'. `createSkillTool` runs the same
  // check for calls the manifest validator rejects before they reach here.
  // This executor backs the bundled subagent skill, so the bundled table is
  // the right one to consult.
  const misuse = bundledToolInputMisuseMessage("subagent_read", input);
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
      content: `Subagent "${state.config.label}" is still ${state.status}. Do not poll: you will be notified automatically when it completes, and that notification tells you whether the result is inlined or waiting behind a read.`,
      isError: false,
    };
  }

  // A terminal subagent can still have a follow-up turn in flight: guidance
  // queued during its run drains after the run itself returns, which is what
  // the completion notification's "queued follow-up guidance is still being
  // processed, read for the latest output" points at. Reading straight through
  // would answer that pointer with the transcript from before the guidance
  // landed, so wait for the queued turn. The wait is bounded and its result
  // reported either way: a subagent still working at the deadline is read as
  // it stands, labelled as unfinished rather than presented as the result.
  const settled = await getSubagentManager().settleQueuedTurns(subagentId);

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

  const footer = statsFooter(subagentId, settled);

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
