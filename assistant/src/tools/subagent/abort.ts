import { getSubagentManager } from "../../subagent/index.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { resolveSubagentId } from "./resolve.js";

export async function executeSubagentAbort(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const subagentId = resolveSubagentId(input, context);
  if (!subagentId && input.label) {
    return {
      content: `No subagent found with label "${input.label as string}".`,
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
