import { cancelCall } from "../../calls/call-domain.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export async function executeCallEnd(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const callSessionId = input.call_session_id as string | undefined;
  if (!callSessionId || typeof callSessionId !== "string") {
    return {
      content: "Error: call_session_id is required and must be a string",
      isError: true,
    };
  }

  const reason = input.end_reason as string | undefined;

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
