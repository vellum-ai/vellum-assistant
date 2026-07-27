import { z } from "zod";

import { getCallStatus } from "../../calls/call-domain.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Model-input schema, `safeParse`d at the top of {@link executeCallStatus}.
 * Same in-tool pattern and TOOLS.json drift guard as the other bundled-skill
 * tools.
 */
export const callStatusInputSchema = z.looseObject({
  call_session_id: nullAsOmitted(z.string()),
});

export async function executeCallStatus(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = callStatusInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("call_status", parsedInput.error);
  }
  const callSessionId = parsedInput.data.call_session_id;

  const result = getCallStatus(callSessionId, context.conversationId);

  if (!result.ok) {
    // When no active call is found and no specific ID was requested, it's not an error
    if (
      !callSessionId &&
      result.error === "No active call found in the current conversation"
    ) {
      return { content: result.error, isError: false };
    }
    return { content: `Error: ${result.error}`, isError: true };
  }

  const { session } = result;
  const lines = [
    `Call Conversation: ${session.id}`,
    `  Status: ${session.status}`,
    `  To: ${session.toNumber}`,
    `  From: ${session.fromNumber}`,
  ];

  if (session.providerCallSid) {
    lines.push(`  Call SID: ${session.providerCallSid}`);
  }

  if (session.task) {
    lines.push(`  Task: ${session.task}`);
  }

  if (session.startedAt) {
    const durationMs = (session.endedAt ?? Date.now()) - session.startedAt;
    const durationSec = Math.round(durationMs / 1000);
    lines.push(`  Duration: ${durationSec}s`);
  }

  if (session.lastError) {
    lines.push(`  Last Error: ${session.lastError}`);
  }

  if (result.pendingQuestion) {
    lines.push("");
    lines.push(`  Pending Question: ${result.pendingQuestion.questionText}`);
    lines.push(`  Question ID: ${result.pendingQuestion.id}`);
  }

  return { content: lines.join("\n"), isError: false };
}
