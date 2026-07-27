import { z } from "zod";

import { getSubagentManager } from "../../subagent/index.js";
import { invalidToolInputResult } from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { resolveSubagentId, subagentSelectorFields } from "./resolve.js";

/**
 * Model-input schema. Both selectors optional — omitting them lists every
 * subagent of the conversation. `activity` is status-only and never read
 * here, so a malformed value degrades instead of failing the call.
 */
export const subagentStatusInputSchema = z.looseObject({
  ...subagentSelectorFields,
  activity: z.string().optional().catch(undefined),
});

export async function executeSubagentStatus(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsed = subagentStatusInputSchema.safeParse(input);
  if (!parsed.success) {
    return invalidToolInputResult("subagent_status", parsed.error);
  }
  const subagentId = resolveSubagentId(parsed.data, context);
  const manager = getSubagentManager();

  // If a label was provided but didn't resolve, that's an error — don't fall
  // through to the "list all" path.
  if (!subagentId && parsed.data.label) {
    return {
      content: `No subagent found with label "${parsed.data.label}".`,
      isError: true,
    };
  }

  if (subagentId) {
    const state = manager.getState(subagentId);
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
