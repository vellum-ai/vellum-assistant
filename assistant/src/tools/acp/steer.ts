import { getAcpSessionManager } from "../../acp/index.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { getSendToClient } from "./context.js";

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
  const sendToClient = getSendToClient(context);

  try {
    if (!sendToClient) {
      // Without a connected client there is no one to receive a resumed
      // session's events, so skip the transparent resume fallback and
      // steer the in-memory session only.
      await manager.steer(acpSessionId, instruction);
      return steeredResult(acpSessionId, { resumed: false });
    }
    // Sessions no longer in memory (completed, or lost to a daemon
    // restart) are transparently resumed from persisted history and the
    // instruction fired in the same call. Failure messages carry the
    // actionable hint (e.g. "recorded before resume support", agent
    // capability missing).
    const { resumed } = await manager.steerOrResume(
      acpSessionId,
      instruction,
      sendToClient,
    );
    return steeredResult(acpSessionId, { resumed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return steerError(acpSessionId, msg);
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
