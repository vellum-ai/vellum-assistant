import { z } from "zod";

import { cancelCall } from "../../calls/call-domain.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Model-input schema, `safeParse`d at the top of {@link executeCallEnd}.
 * Same in-tool pattern and TOOLS.json drift guard as the other bundled-skill
 * tools. The bespoke required check below keeps its error message for the
 * missing/null/empty cases.
 */
export const callEndInputSchema = z.looseObject({
  call_session_id: nullAsOmitted(z.string()),
  end_reason: nullAsOmitted(z.string()),
});

export async function executeCallEnd(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = callEndInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("call_end", parsedInput.error);
  }
  const callSessionId = parsedInput.data.call_session_id;
  if (!callSessionId) {
    return {
      content: "Error: call_session_id is required and must be a string",
      isError: true,
    };
  }

  const reason = parsedInput.data.end_reason;

  const result = await cancelCall({ callSessionId, reason });

  if (!result.ok) {
    // If the call already ended, report it as a non-error for the tool
    if (result.status === 409) {
      return { content: result.error, isError: false };
    }
    return { content: `Error: ${result.error}`, isError: true };
  }

  const lines = [
    "Call ended successfully.",
    `  Call Session ID: ${callSessionId}`,
    `  Status: cancelled`,
  ];
  if (reason) {
    lines.push(`  Reason: ${reason}`);
  }

  return { content: lines.join("\n"), isError: false };
}
