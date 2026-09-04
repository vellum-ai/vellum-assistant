/**
 * `send_user_message`: the one channel a user-facing reply travels on when
 * the `send-user-message` flag is on.
 *
 * Under the flag the model's plain assistant text is private working notes:
 * the daemon suppresses it from the live stream and projects it as thinking
 * when it renders history, so the only text a user reads is what this tool
 * carries. Execution is a no-op on purpose. The daemon emits the message the
 * moment the call is dispatched (`handleToolUse` in
 * `daemon/conversation-agent-loop-handlers.ts`) and the persisted assistant
 * row already holds the call, so there is nothing left for the executor to
 * deliver; it only acknowledges so the model can keep working.
 *
 * The tool is main-agent only. `isToolActiveForContext` hides it when the
 * flag is off and on every subagent, worker, live-voice, and call turn.
 */

import { z } from "zod";

import { SEND_USER_MESSAGE_TOOL_NAME } from "../../config/send-user-message-constants.js";
import { RiskLevel } from "../../permissions/types.js";
import {
  invalidToolInputResult,
  toToolInputSchema,
} from "../shared/zod-tool-schema.js";
import type { ToolDefinition, ToolExecutionResult } from "../types.js";

export const sendUserMessageInputSchema = z.looseObject({
  message: z
    .string()
    .min(1)
    .describe(
      "What the user reads. 1 to 3 plain sentences, markdown allowed. No " +
        "reasoning, no tool or file names, no status jargon.",
    ),
});

export type SendUserMessageInput = z.infer<typeof sendUserMessageInputSchema>;

const DESCRIPTION = [
  "Send a message to the user. This is the ONLY channel the user reads.",
  "",
  "Everything else you write is private working notes: your plain text is a",
  "scratchpad for thinking, and the user never sees a word of it. If it is not",
  "in a send_user_message call, it did not reach them.",
  "",
  "Call it before you start tool work, so the user knows what you are doing,",
  "and once when you are done, with the answer or the result.",
  "",
  "Rules for the message:",
  "- 1 to 3 plain sentences. One is usually right.",
  "- No reasoning, no technical narration, no tool or file names.",
  "- Do not repeat what you already sent. Say the new thing.",
].join("\n");

export const sendUserMessageTool = {
  name: SEND_USER_MESSAGE_TOOL_NAME,
  description: DESCRIPTION,
  category: "interaction",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: toToolInputSchema(sendUserMessageInputSchema),

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = sendUserMessageInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult(SEND_USER_MESSAGE_TOOL_NAME, parsed.error);
    }
    return { content: "Delivered.", isError: false };
  },
} satisfies ToolDefinition;
