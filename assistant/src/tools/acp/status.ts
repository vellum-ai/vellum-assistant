import { getAcpSessionManager } from "../../acp/index.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export async function executeAcpStatus(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const acpSessionId = input.acp_session_id as string | undefined;
  const manager = getAcpSessionManager();

  try {
    if (acpSessionId) {
      const state = manager.getStatus(acpSessionId);
      return {
        content: JSON.stringify(state),
        isError: false,
      };
    }

    // List all sessions.
    const allStates = manager.getStatus();
    if (Array.isArray(allStates) && allStates.length === 0) {
      return { content: "No ACP sessions found.", isError: false };
    }

    return { content: JSON.stringify(allStates), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: msg, isError: true };
  }
}
