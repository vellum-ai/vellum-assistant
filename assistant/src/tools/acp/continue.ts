import { getAcpSessionManager } from "../../acp/index.js";
import { SessionBusyError } from "../../acp/session-manager.js";
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

  // Resolution + the running-session rejection live in the shared
  // `manager.continueSession` helper (single source of truth, also used by the
  // HTTP route). The tool only translates the outcome into `{ isError }`.
  const explicitId = input.acp_session_id as string | undefined;
  try {
    const { acpSessionId } = await manager.continueSession({
      acpSessionId: explicitId,
      parentConversationId: explicitId ? undefined : context.conversationId,
      instruction,
    });

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
    if (err instanceof SessionBusyError) {
      return { content: err.message, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    // The explicit-id path wraps the failure with its session label; the
    // conversation path surfaces the manager's message plus the long-standing
    // spawn/pass-id remediation hint.
    return {
      content: explicitId
        ? `Could not continue ACP session "${explicitId}": ${msg}`
        : `${msg} Spawn a fresh session with acp_spawn, or pass acp_session_id.`,
      isError: true,
    };
  }
}
