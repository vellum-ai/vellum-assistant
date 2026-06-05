import { getAcpSessionManager } from "../../acp/index.js";
import { isAcpSessionNotFoundError } from "../../acp/session-manager.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export async function executeAcpSteer(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const acpSessionId = input.acp_session_id as string;
  if (!acpSessionId) {
    return { content: '"acp_session_id" is required.', isError: true };
  }

  const instruction = input.instruction as string;
  if (!instruction) {
    return { content: '"instruction" is required.', isError: true };
  }

  const manager = getAcpSessionManager();

  try {
    await manager.steer(acpSessionId, instruction);
    return steeredResult(acpSessionId, { resumed: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // "Not found" means the session is no longer in memory (it completed,
    // or the daemon restarted). Transparently resume it from persisted
    // history and retry, when a client is connected to receive the
    // resumed session's events.
    const sendToClient = context.sendToClient as
      | ((msg: { type: string; [key: string]: unknown }) => void)
      | undefined;
    if (!isAcpSessionNotFoundError(err, acpSessionId) || !sendToClient) {
      return steerError(acpSessionId, msg);
    }

    try {
      await manager.resumeFromHistory(
        acpSessionId,
        sendToClient as (msg: unknown) => void,
      );
      await manager.steer(acpSessionId, instruction);
    } catch (resumeErr) {
      // The resume error carries the actionable hint (e.g. "recorded
      // before resume support", agent capability missing).
      const resumeMsg =
        resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
      return steerError(acpSessionId, resumeMsg);
    }
    return steeredResult(acpSessionId, { resumed: true });
  }
}

function steeredResult(
  acpSessionId: string,
  opts: { resumed: boolean },
): ToolExecutionResult {
  return {
    content: JSON.stringify({
      acpSessionId,
      status: "steered",
      ...(opts.resumed ? { resumed: true } : {}),
      message: opts.resumed
        ? "Session was resumed from history; new instruction is now running."
        : "Interrupted in-flight prompt; new instruction is now running.",
    }),
    isError: false,
  };
}

function steerError(acpSessionId: string, msg: string): ToolExecutionResult {
  return {
    content: `Could not steer ACP session "${acpSessionId}": ${msg}`,
    isError: true,
  };
}
