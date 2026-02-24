import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { forwardTwilioVoiceWebhook } from "../../runtime/client.js";
import { resolveAssistantByPhoneNumber } from "../../routing/resolve-assistant.js";
import { validateTwilioWebhookRequest } from "../../twilio/validate-webhook.js";

const log = getLogger("twilio-voice-webhook");

export function createTwilioVoiceWebhookHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    const validation = await validateTwilioWebhookRequest(req, config);
    if (validation instanceof Response) return validation;

    const { params } = validation;
    log.info({ callSid: params.CallSid }, "Twilio voice webhook received");

    // For inbound calls (no callSessionId in the URL), resolve the assistant
    // by the "To" phone number so the runtime knows which assistant to use.
    const url = new URL(req.url);
    const hasCallSessionId = url.searchParams.has("callSessionId");
    let assistantId: string | undefined;

    if (!hasCallSessionId && params.To) {
      const routing = resolveAssistantByPhoneNumber(config, params.To);
      if (routing && "assistantId" in routing) {
        assistantId = routing.assistantId;
        log.info({ assistantId, toNumber: params.To }, "Resolved assistant by phone number for inbound call");
      }
    }

    try {
      const runtimeResponse = await forwardTwilioVoiceWebhook(config, params, req.url, assistantId);
      return new Response(runtimeResponse.body, {
        status: runtimeResponse.status,
        headers: runtimeResponse.headers,
      });
    } catch (err) {
      log.error({ err }, "Failed to forward Twilio voice webhook to runtime");
      return Response.json({ error: "Internal server error" }, { status: 502 });
    }
  };
}
