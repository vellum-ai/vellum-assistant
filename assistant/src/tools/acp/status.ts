import { z } from "zod";

import { getAcpSessionManager } from "../../acp/index.js";
import type { AcpSessionState } from "../../acp/types.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Model-input schema, `safeParse`d at the top of {@link executeAcpStatus}.
 * Same in-tool pattern and TOOLS.json drift guard as the other bundled-skill
 * tools.
 */
export const acpStatusInputSchema = z.looseObject({
  acp_session_id: nullAsOmitted(z.string()),
});

/**
 * The session fields worth spending LLM context on. An allowlist rather than
 * an omission: `availableModels` is a picker for the human surfaces (HTTP and
 * SSE) that says nothing the agent can act on, and a field added to
 * `AcpSessionState` for those surfaces should not reach this one by default.
 * `model` stays: which model a session is running on is answerable.
 */
function projectSession(state: AcpSessionState) {
  return {
    id: state.id,
    agentId: state.agentId,
    acpSessionId: state.acpSessionId,
    parentConversationId: state.parentConversationId,
    status: state.status,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    error: state.error,
    stopReason: state.stopReason,
    task: state.task,
    parentToolUseId: state.parentToolUseId,
    authErrorCode: state.authErrorCode,
    authErrorCredential: state.authErrorCredential,
    latestUsage: state.latestUsage,
    model: state.model,
  };
}

/** Projects either shape `getStatus` answers with. */
function projectStatus(status: AcpSessionState | AcpSessionState[]): unknown {
  return Array.isArray(status)
    ? status.map(projectSession)
    : projectSession(status);
}

export async function executeAcpStatus(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = acpStatusInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("acp_status", parsedInput.error);
  }
  const acpSessionId = parsedInput.data.acp_session_id;
  const manager = getAcpSessionManager();

  try {
    if (acpSessionId) {
      return {
        content: JSON.stringify(projectStatus(manager.getStatus(acpSessionId))),
        isError: false,
      };
    }

    // List all sessions.
    const allStates = manager.getStatus();
    if (Array.isArray(allStates) && allStates.length === 0) {
      return { content: "No ACP sessions found.", isError: false };
    }

    return {
      content: JSON.stringify(projectStatus(allStates)),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: msg, isError: true };
  }
}
