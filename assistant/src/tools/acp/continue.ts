import { getAcpSessionManager } from "../../acp/index.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Sends a follow-up turn to an EXISTING live (running/idle) ACP session so the
 * agent builds on the same context and workspace it already established.
 *
 * Distinct from `acp_spawn` (which starts a FRESH session/process) and from
 * `acp_steer` (which interrupts the in-flight prompt). `acp_continue` queues a
 * new turn on a session that is alive — typically one that has gone `idle`
 * after completing its previous task — via `manager.steer`.
 *
 * Targeting resolves in two ways:
 *  - An explicit `acp_session_id`, when the assistant already knows which
 *    session to continue.
 *  - Otherwise, the current conversation's most-recent live session via
 *    `getLiveSessionForConversation`.
 *
 * Closed / non-existent sessions error cleanly (isError), never crash — either
 * because no live session exists for the conversation or because
 * `manager.steer` rejects for an unknown / non-reusable session id.
 */
export async function executeAcpContinue(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const instruction = input.instruction as string;
  if (!instruction) {
    return { content: '"instruction" is required.', isError: true };
  }

  const manager = getAcpSessionManager();

  // Resolve the target session: an explicit id wins; otherwise fall back to
  // the conversation's most-recent live (running/idle) session.
  let acpSessionId = input.acp_session_id as string | undefined;
  if (!acpSessionId) {
    const live = manager.getLiveSessionForConversation(context.conversationId);
    if (!live) {
      return {
        content:
          "No live ACP session to continue for this conversation. " +
          "Spawn a fresh session with acp_spawn, or pass acp_session_id.",
        isError: true,
      };
    }
    acpSessionId = live.id;
  }

  try {
    await manager.steer(acpSessionId, instruction);

    return {
      content: JSON.stringify({
        acpSessionId,
        status: "continued",
        message:
          "Follow-up turn started on the existing ACP session. " +
          "Results stream back via SSE; you will be notified when it completes.",
      }),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: `Could not continue ACP session "${acpSessionId}": ${msg}`,
      isError: true,
    };
  }
}
