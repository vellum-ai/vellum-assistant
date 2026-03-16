import { getSubagentManager } from "../../subagent/index.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export async function executeSubagentSpawn(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const label = input.label as string;
  const objective = input.objective as string;
  const extraContext = input.context as string | undefined;
  const sendResultToUser = input.send_result_to_user !== false;

  if (!label || !objective) {
    return {
      content: 'Both "label" and "objective" are required.',
      isError: true,
    };
  }

  const manager = getSubagentManager();
  const sendToClient = context.sendToClient as
    | ((msg: { type: string; [key: string]: unknown }) => void)
    | undefined;
  if (!sendToClient) {
    return {
      content: "No client connected — cannot spawn subagent.",
      isError: true,
    };
  }

  try {
    const subagentId = await manager.spawn(
      {
        parentSessionId: context.conversationId,
        label,
        objective,
        context: extraContext,
        sendResultToUser,
      },
      sendToClient as (msg: unknown) => void,
    );

    return {
      content: JSON.stringify({
        subagentId,
        label,
        status: "pending",
        message: `Subagent "${label}" spawned. You will be notified automatically when it completes or fails — do NOT poll subagent_status. Continue the conversation normally.`,
      }),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Failed to spawn subagent: ${msg}`, isError: true };
  }
}
