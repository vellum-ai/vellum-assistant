import { getSubagentManager } from "../../subagent/index.js";
import { invalidToolInputResult } from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import {
  resolveSubagentId,
  resolveSubagentState,
  subagentRefInputSchema,
} from "./resolve.js";

export const subagentStatusInputSchema = subagentRefInputSchema;

export async function executeSubagentStatus(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = subagentStatusInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("subagent_status", parsedInput.error);
  }
  const parsed = parsedInput.data;
  const subagentId = resolveSubagentId(parsed, context);
  const manager = getSubagentManager();

  // If a label was provided but didn't resolve, that's an error — don't fall
  // through to the "list all" path.
  if (!subagentId && parsed.label) {
    return {
      content: `No subagent found with label "${parsed.label}".`,
      isError: true,
    };
  }

  if (subagentId) {
    const state = resolveSubagentState(subagentId);
    if (
      !state ||
      state.config.parentConversationId !== context.conversationId
    ) {
      return {
        content: `No subagent found with ID "${subagentId}".`,
        isError: true,
      };
    }
    return {
      content: JSON.stringify({
        subagentId: state.config.id,
        label: state.config.label,
        status: state.status,
        isFork: state.isFork,
        error: state.error,
        createdAt: state.createdAt,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        usage: state.usage,
      }),
      isError: false,
    };
  }

  // List all subagents for this parent conversation.
  const children = manager.getChildrenOf(context.conversationId);
  if (children.length === 0) {
    return {
      content: "No subagents found for this conversation.",
      isError: false,
    };
  }

  const summary = children.map((s) => ({
    subagentId: s.config.id,
    label: s.config.label,
    status: s.status,
    isFork: s.isFork,
    error: s.error,
  }));

  return { content: JSON.stringify(summary), isError: false };
}
