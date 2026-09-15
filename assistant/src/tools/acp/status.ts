import { z } from "zod";

import {
  type AcpSessionSnapshot,
  getAcpSessionSnapshot,
  listAcpSessionSnapshots,
} from "../../acp/session-snapshot.js";
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
function projectSession(snapshot: AcpSessionSnapshot) {
  const fromHistory = snapshot.source === "history";
  const idle =
    fromHistory &&
    snapshot.status === "completed" &&
    snapshot.stopReason !== "cancelled" &&
    snapshot.resumable;
  const latestUsage =
    snapshot.usedTokens !== undefined && snapshot.contextSize !== undefined
      ? {
          usedTokens: snapshot.usedTokens,
          contextSize: snapshot.contextSize,
          costAmount: snapshot.costAmount,
          costCurrency: snapshot.costCurrency,
          inputTokens: snapshot.inputTokens,
          outputTokens: snapshot.outputTokens,
        }
      : undefined;
  return {
    id: snapshot.id,
    agentId: snapshot.agentId,
    acpSessionId: snapshot.acpSessionId,
    parentConversationId: snapshot.parentConversationId,
    status: idle ? "idle" : snapshot.status,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt ?? undefined,
    error: snapshot.error ?? undefined,
    stopReason: snapshot.stopReason ?? undefined,
    task: snapshot.task,
    parentToolUseId: snapshot.parentToolUseId,
    authErrorCode: snapshot.authErrorCode,
    latestUsage,
    model: snapshot.model,
    ...(fromHistory
      ? {
          resumable: snapshot.resumable,
          lastRunStatus: snapshot.status,
        }
      : {}),
  };
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
  try {
    if (acpSessionId) {
      const snapshot = getAcpSessionSnapshot(acpSessionId, {
        includeEventLog: false,
      });
      if (!snapshot) {
        return {
          content: `ACP session "${acpSessionId}" not found`,
          isError: true,
        };
      }
      return {
        content: JSON.stringify(projectSession(snapshot)),
        isError: false,
      };
    }

    const snapshots = listAcpSessionSnapshots({
      limit: 50,
      includeEventLog: false,
    }).sessions.slice(0, 50);
    if (snapshots.length === 0) {
      return { content: "No ACP sessions found.", isError: false };
    }

    return {
      content: JSON.stringify(snapshots.map(projectSession)),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: msg, isError: true };
  }
}
