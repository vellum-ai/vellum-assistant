import { z } from "zod";

import { getSubagentManager } from "../../subagent/index.js";
import { invalidToolInputResult } from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { resolveSubagentId, subagentSelectorFields } from "./resolve.js";

/**
 * Model-input schema. One of the selectors is required, enforced in the
 * executor so the "or" error message stays intact. `activity` is status-only
 * and never read here, so a malformed value degrades instead of failing the
 * call.
 */
export const subagentAbortInputSchema = z.looseObject({
  ...subagentSelectorFields,
  activity: z.string().optional().catch(undefined),
});

export async function executeSubagentAbort(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsed = subagentAbortInputSchema.safeParse(input);
  if (!parsed.success) {
    return invalidToolInputResult("subagent_abort", parsed.error);
  }
  const subagentId = resolveSubagentId(parsed.data, context);
  if (!subagentId && parsed.data.label) {
    return {
      content: `No subagent found with label "${parsed.data.label}".`,
      isError: true,
    };
  }
  if (!subagentId) {
    return {
      content: '"subagent_id" or "label" is required.',
      isError: true,
    };
  }

  const manager = getSubagentManager();
  const sendToClient = context.sendToClient as
    | ((msg: unknown) => void)
    | undefined;
  const aborted = manager.abort(
    subagentId,
    sendToClient as ((msg: unknown) => void) | undefined,
    context.conversationId,
    { suppressNotification: true },
  );

  if (!aborted) {
    return {
      content: `Could not abort subagent "${subagentId}". It may not exist or already be in a terminal state.`,
      isError: true,
    };
  }

  return {
    content: JSON.stringify({
      subagentId,
      status: "aborted",
      message: "Subagent aborted successfully.",
    }),
    isError: false,
  };
}
