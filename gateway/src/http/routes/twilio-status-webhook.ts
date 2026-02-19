import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { forwardTwilioStatusWebhook } from "../../runtime/client.js";
import { validateTwilioWebhookRequest } from "../../twilio/validate-webhook.js";

const log = getLogger("twilio-status-webhook");

export function createTwilioStatusWebhookHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    const validation = await validateTwilioWebhookRequest(req, config);
    if (validation instanceof Response) return validation;

    const { params } = validation;
    log.info(
      { callSid: params.CallSid, callStatus: params.CallStatus },
      "Twilio status webhook received",
    );

    try {
      const runtimeResponse = await forwardTwilioStatusWebhook(config, params);
      return new Response(runtimeResponse.body, {
        status: runtimeResponse.status,
        headers: runtimeResponse.headers,
      });
    } catch (err) {
      log.error({ err }, "Failed to forward Twilio status webhook to runtime");
      return Response.json({ error: "Internal server error" }, { status: 502 });
    }
  };
}
