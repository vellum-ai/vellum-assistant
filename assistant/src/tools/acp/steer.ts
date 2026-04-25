import { getAcpSessionManager } from "../../acp/index.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export async function executeAcpSteer(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const acpSessionId = input.acp_session_id as string;
  if (!acpSessionId) {
    return { content: '"acp_session_id" is required.', isError: true };
  }

  const instruction = input.instruction as string;
  if (!instruction) {
    return { content: '"instruction" is required.', isError: true };
  }

  try {
    const manager = getAcpSessionManager();
    await manager.steer(acpSessionId, instruction);

    return {
      content: JSON.stringify({
        acpSessionId,
        status: "steered",
        message:
          "Interrupted in-flight prompt; new instruction is now running.",
      }),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: `Could not steer ACP session "${acpSessionId}": ${msg}`,
      isError: true,
    };
  }
}
