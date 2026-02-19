import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { forwardTwilioVoiceWebhook } from "../../runtime/client.js";
import { validateTwilioWebhookRequest } from "../../twilio/validate-webhook.js";

const log = getLogger("twilio-voice-webhook");

export function createTwilioVoiceWebhookHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    const validation = await validateTwilioWebhookRequest(req, config);
    if (validation instanceof Response) return validation;

    const { params } = validation;
    log.info({ callSid: params.CallSid }, "Twilio voice webhook received");

    try {
      const runtimeResponse = await forwardTwilioVoiceWebhook(config, params, req.url);
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
