import { z } from "zod";

import { getAcpSessionManager } from "../../acp/index.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Model-input schema, `safeParse`d at the top of {@link executeAcpAbort}.
 * Same in-tool pattern and TOOLS.json drift guard as the other bundled-skill
 * tools. The bespoke required check keeps its message for the
 * missing/null/empty cases.
 */
export const acpAbortInputSchema = z.looseObject({
  acp_session_id: nullAsOmitted(z.string()),
});

export async function executeAcpAbort(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = acpAbortInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("acp_abort", parsedInput.error);
  }
  const acpSessionId = parsedInput.data.acp_session_id;
  if (!acpSessionId) {
    return { content: '"acp_session_id" is required.', isError: true };
  }

  try {
    const manager = getAcpSessionManager();
    manager.close(acpSessionId);

    return {
      content: JSON.stringify({
        acpSessionId,
        status: "aborted",
        message: "ACP session aborted successfully.",
      }),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: `Could not abort ACP session "${acpSessionId}": ${msg}`,
      isError: true,
    };
  }
}
