/**
 * Handler for inbound Twilio SMS webhooks forwarded from the gateway.
 *
 * Converts Twilio SMS parameters into a channel inbound message and
 * routes it through the standard channel inbound pipeline using the
 * "phone" channel.
 */

import type { HeartbeatService } from "../heartbeat/heartbeat-service.js";
import type { MessageProcessor } from "../runtime/http-types.js";
import type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  GuardianActionCopyGenerator,
  GuardianFollowUpConversationGenerator,
} from "../runtime/http-types.js";
import { handleChannelInbound } from "../runtime/routes/channel-inbound-routes.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("twilio-sms");

export interface SmsHandlerDeps {
  assistantId: string;
  processMessage?: MessageProcessor;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  approvalConversationGenerator?: ApprovalConversationGenerator;
  guardianActionCopyGenerator?: GuardianActionCopyGenerator;
  guardianFollowUpConversationGenerator?: GuardianFollowUpConversationGenerator;
  getHeartbeatService?: () => HeartbeatService | undefined;
}

/**
 * Handle an inbound SMS from Twilio.
 *
 * The gateway validates the Twilio signature and forwards the form
 * parameters as JSON `{ params: Record<string, string> }`.
 * This handler translates those params into the shape expected by
 * `handleChannelInbound` (the standard channel message pipeline).
 */
export async function handleSmsWebhook(
  req: Request,
  deps: SmsHandlerDeps,
): Promise<Response> {
  const json = (await req.json()) as { params: Record<string, string> };
  const params = json.params;

  const messageSid = params.MessageSid ?? params.SmsSid;
  const from = params.From;
  const to = params.To;
  const body = (params.Body ?? "").trim();

  if (!messageSid || !from) {
    log.warn({ params }, "SMS webhook missing required fields");
    return Response.json(
      { error: "Missing MessageSid or From" },
      { status: 400 },
    );
  }

  const numMedia = parseInt(params.NumMedia ?? "0", 10);

  // MMS with media-only (no text body) can't be processed through the channel
  // pipeline yet because media URLs aren't extracted into attachments. Return
  // 200 to prevent Twilio retry storms.
  if (!body && numMedia > 0) {
    log.warn(
      { messageSid, from, numMedia },
      "Dropping media-only MMS — media attachment processing not yet supported",
    );
    return new Response(null, { status: 200 });
  }

  log.info({ messageSid, from, to }, "Processing inbound SMS");

  const conversationExternalId = from;
  const actorExternalId = from;

  const channelPayload = {
    sourceChannel: "phone",
    interface: "phone",
    conversationExternalId,
    externalMessageId: messageSid,
    content: body,
    actorExternalId,
    actorDisplayName: from,
    sourceMetadata: {
      twilioMessageSid: messageSid,
      twilioFrom: from,
      twilioTo: to,
      twilioNumMedia: params.NumMedia,
    },
  };

  const syntheticReq = new Request(req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(channelPayload),
  });

  return handleChannelInbound(
    syntheticReq,
    deps.processMessage,
    deps.assistantId,
    deps.approvalCopyGenerator,
    deps.approvalConversationGenerator,
    deps.guardianActionCopyGenerator,
    deps.guardianFollowUpConversationGenerator,
    deps.getHeartbeatService?.(),
  );
}
