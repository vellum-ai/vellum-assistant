import { getAcpSessionManager } from "../../acp/index.js";
import { SessionCancelledError } from "../../acp/session-manager.js";
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
    // A cancel that raced the steer tore the session down before the new
    // instruction fired — report the cancellation precisely (not a generic
    // failure) so the assistant knows the prior task was cancelled and nothing
    // is now running.
    if (err instanceof SessionCancelledError) {
      return {
        content:
          `ACP session "${acpSessionId}" was cancelled before the ` +
          "instruction could run; nothing is running now.",
        isError: true,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: `Could not steer ACP session "${acpSessionId}": ${msg}`,
      isError: true,
    };
  }
}
