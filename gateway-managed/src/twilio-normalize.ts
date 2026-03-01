import type { ManagedGatewayInboundEvent } from "./managed-inbound-event.js";

export function normalizeManagedTwilioSmsPayload(
  params: Record<string, string>,
  receivedAt: string = new Date().toISOString(),
): ManagedGatewayInboundEvent {
  const body = params.Body || "";
  const from = params.From || "";
  const to = params.To || "";
  const messageSid = params.MessageSid || "";

  return {
    version: "v1",
    sourceChannel: "sms",
    receivedAt,
    message: {
      content: body,
      conversationExternalId: from,
      externalMessageId: messageSid,
    },
    actor: {
      actorExternalId: from,
      displayName: from || undefined,
    },
    source: {
      updateId: messageSid,
      messageId: messageSid,
      to,
    },
    raw: {
      ...params,
      _to: to,
    },
  };
}

export function normalizeManagedTwilioVoicePayload(
  params: Record<string, string>,
  receivedAt: string = new Date().toISOString(),
): ManagedGatewayInboundEvent {
  const from = params.From || "";
  const to = params.To || "";
  const callSid = params.CallSid || "";
  const callStatus = params.CallStatus || "";

  return {
    version: "v1",
    sourceChannel: "voice",
    receivedAt,
    message: {
      content: "",
      conversationExternalId: from,
      externalMessageId: callSid,
    },
    actor: {
      actorExternalId: from,
      displayName: from || undefined,
    },
    source: {
      updateId: callSid,
      messageId: callSid,
      to,
      callStatus,
    },
    raw: {
      ...params,
      _to: to,
      _call_status: callStatus,
    },
  };
}
