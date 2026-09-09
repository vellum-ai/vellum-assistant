import { z } from "zod";

import { getAcpSessionManager } from "../../acp/index.js";
import {
  AcpModelNotOfferedError,
  AcpModelSelectionUnsupportedError,
  AcpSessionNotFoundError,
} from "../../acp/session-manager.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Model-input schema, `safeParse`d at the top of {@link executeAcpSetModel}.
 * Same in-tool pattern and TOOLS.json drift guard as the other bundled-skill
 * tools. The bespoke required checks keep their messages for the
 * missing/null/empty cases.
 */
export const acpSetModelInputSchema = z.looseObject({
  acp_session_id: nullAsOmitted(z.string()),
  model: nullAsOmitted(z.string()),
});

export async function executeAcpSetModel(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = acpSetModelInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("acp_set_model", parsedInput.error);
  }
  const acpSessionId = parsedInput.data.acp_session_id;
  if (!acpSessionId) {
    return { content: '"acp_session_id" is required.', isError: true };
  }
  const model = parsedInput.data.model?.trim();
  if (!model) {
    return { content: '"model" is required.', isError: true };
  }

  try {
    const state = await getAcpSessionManager().setModel(acpSessionId, model);
    return {
      content: JSON.stringify({
        acpSessionId,
        model: state.model ?? model,
        status: "model_set",
        message:
          "The agent applies it from the next turn; a prompt already running finishes on the model it started on.",
      }),
      isError: false,
    };
  } catch (err) {
    return {
      content: describeSetModelFailure(acpSessionId, err),
      isError: true,
    };
  }
}

/**
 * One sentence the assistant can relay as-is.
 *
 * Only the typed rejections name the model as the problem, because only they
 * are the manager answering. Anything else reaching this catch is the adapter
 * call failing rather than answering (a dead subprocess, an RPC timeout, an
 * auth refresh), and `setConfigOption` rejects with the raw transport error,
 * so a genuine refusal is not distinguishable from one of those here. Calling
 * that a refusal would tell the assistant the session is healthy and still
 * running on its old model, which is exactly what is unknown, so the fallback
 * stays neutral and points at the tool that can answer it.
 */
function describeSetModelFailure(acpSessionId: string, err: unknown): string {
  if (err instanceof AcpSessionNotFoundError) {
    return `ACP session "${acpSessionId}" is not running - the id is unknown, or the session has ended. Spawn a new session on the model you want.`;
  }
  if (err instanceof AcpModelSelectionUnsupportedError) {
    return `The agent running ACP session "${acpSessionId}" advertises no model selector, so its model cannot be switched.`;
  }
  if (err instanceof AcpModelNotOfferedError) {
    return err.message;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `Could not switch the model on ACP session "${acpSessionId}": ${msg}. Check the session with acp_status before relying on it.`;
}
