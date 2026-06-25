import { startCall } from "../../calls/call-domain.js";
import { getConfig } from "../../config/loader.js";
import { findActiveSession } from "../../runtime/channel-verification-service.js";
import { normalizePhoneNumber } from "../../util/phone.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

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

  const requestedPhone =
    typeof input.phone_number === "string"
      ? normalizePhoneNumber(input.phone_number)
      : null;
  if (requestedPhone) {
    const activeVoiceVerification = findActiveSession("phone");
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
    phoneNumber: input.phone_number as string,
    task: input.task as string,
    context: input.context as string | undefined,
    conversationId: context.conversationId,
    assistantId: context.assistantId,
    callerIdentityMode: input.caller_identity_mode as
      | "assistant_number"
      | "user_number"
      | undefined,
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
