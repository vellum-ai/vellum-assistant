import { getAcpSessionManager } from "../../acp/index.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export async function executeAcpAbort(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const acpSessionId = input.acp_session_id as string;
  if (!acpSessionId) {
    return { content: '"acp_session_id" is required.', isError: true };
  }

  try {
    const manager = getAcpSessionManager();
    manager.close(acpSessionId);

    return {
      content: JSON.stringify({
        acpSessionId,
        status: "aborted",
        message: "ACP session aborted successfully.",
      }),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: `Could not abort ACP session "${acpSessionId}": ${msg}`,
      isError: true,
    };
  }
}
