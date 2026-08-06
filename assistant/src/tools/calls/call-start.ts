import { z } from "zod";

import { startCall } from "../../calls/call-domain.js";
import { findActiveSession } from "../../channels/gateway-verification-sessions.js";
import { getConfig } from "../../config/loader.js";
import { normalizePhoneNumber } from "../../util/phone.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Model-input schema, `safeParse`d at the top of {@link executeCallStart}.
 * Same in-tool pattern and TOOLS.json drift guard as the other bundled-skill
 * tools — see the schema block in `tools/document/document-tool.ts` for the
 * framework. The advertised-required fields are required here — schema
 * rejection is the only guard between a mistyped `phone_number`/`task` and
 * `startCall`. `skip_disclosure` (deliberate `=== true` coercion) is
 * UNDECLARED — loose passthrough.
 */
export const callStartInputSchema = z.looseObject({
  phone_number: z.string(),
  task: z.string(),
  context: nullAsOmitted(z.string()),
  caller_identity_mode: nullAsOmitted(
    z.enum(["assistant_number", "user_number"]),
  ),
});

export async function executeCallStart(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (!getConfig().calls.enabled) {
    return {
      content:
        "Error: Calls feature is disabled via configuration. Set calls.enabled to true to use this feature.",
      isError: true,
    };
  }

  const parsedInput = callStartInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("call_start", parsedInput.error);
  }
  const parsed = parsedInput.data;

  const requestedPhone = normalizePhoneNumber(parsed.phone_number);
  if (requestedPhone) {
    const activeVoiceVerification = await findActiveSession("phone");
    const verificationDestination =
      activeVoiceVerification?.destinationAddress ??
      activeVoiceVerification?.expectedPhoneE164;
    if (verificationDestination === requestedPhone) {
      return {
        content: [
          "Error: A guardian voice verification call is already active for this number.",
          "Use the guardian outbound verification flow via the gateway API (`/v1/channel-verification-sessions` or `/channel-verification-sessions/resend`) and wait for completion before using `call_start`.",
        ].join(" "),
        isError: true,
      };
    }
  }

  const result = await startCall({
    phoneNumber: parsed.phone_number,
    task: parsed.task,
    context: parsed.context,
    conversationId: context.conversationId,
    assistantId: context.assistantId,
    callerIdentityMode: parsed.caller_identity_mode,
    skipDisclosure: input.skip_disclosure === true,
  });

  if (!result.ok) {
    return { content: `Error: ${result.error}`, isError: true };
  }

  return {
    content: [
      "Call initiated successfully.",
      `  Call Conversation ID: ${result.session.id}`,
      `  Call SID: ${result.callSid}`,
      `  To: ${result.session.toNumber}`,
      `  From: ${result.session.fromNumber}`,
      `  Caller Identity Mode: ${result.callerIdentityMode}`,
      `  Status: initiated`,
      "",
      "The AI voice assistant is now placing the call. Use call_status to check progress.",
    ].join("\n"),
    isError: false,
  };
}
