import { getAcpSessionManager } from "../../acp/index.js";
import type { AcpSessionState } from "../../acp/types.js";
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
 *
 * A session whose prompt is still in flight (`running`/`initializing`) is
 * refused with a clean `isError` result rather than steered: `manager.steer`'s
 * running-session path CANCELS the in-flight prompt, so continuing a busy
 * session would abort the in-progress task. Only an idle (or otherwise
 * non-running live) session is continued.
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
  // the conversation's most-recent live (running/idle) session. Capture the
  // resolved session's live status so we can refuse to continue one whose
  // prompt is still in flight (see the busy guard below).
  let acpSessionId = input.acp_session_id as string | undefined;
  let status: AcpSessionState["status"] | undefined;
  if (acpSessionId) {
    try {
      const state = manager.getStatus(acpSessionId);
      if (!Array.isArray(state)) status = state.status;
    } catch {
      // Unknown / closed session id — surface the same clean error the steer
      // rejection path produces below.
      return {
        content:
          `Could not continue ACP session "${acpSessionId}": ` +
          "session not found or not reusable.",
        isError: true,
      };
    }
  } else {
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
    status = live.status;
  }

  // A prompt is still in flight: `manager.steer`'s running-session path would
  // CANCEL it, so a follow-up like "also do X" would abort in-progress work.
  // Refuse cleanly and let the caller wait for the current task to finish.
  if (status === "running" || status === "initializing") {
    return {
      content:
        `ACP session "${acpSessionId}" is busy (${status}); wait for the ` +
        "current task to finish before continuing.",
      isError: true,
    };
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
