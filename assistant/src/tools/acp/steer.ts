import { z } from "zod";

import { getAcpSessionManager } from "../../acp/index.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { getSendToClient } from "./context.js";

/**
 * Model-input schema, `safeParse`d at the top of {@link executeAcpSteer}.
 * Same in-tool pattern and TOOLS.json drift guard as the other bundled-skill
 * tools. The bespoke required checks keep their (test-asserted) messages for
 * the missing/null/empty cases.
 */
export const acpSteerInputSchema = z.looseObject({
  acp_session_id: nullAsOmitted(z.string()),
  instruction: nullAsOmitted(z.string()),
});

export async function executeAcpSteer(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = acpSteerInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("acp_steer", parsedInput.error);
  }
  const acpSessionId = parsedInput.data.acp_session_id;
  if (!acpSessionId) {
    return { content: '"acp_session_id" is required.', isError: true };
  }

  const instruction = parsedInput.data.instruction;
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
