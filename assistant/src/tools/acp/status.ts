import { z } from "zod";

import { getAcpSessionManager } from "../../acp/index.js";
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
