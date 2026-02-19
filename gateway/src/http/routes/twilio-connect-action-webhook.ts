import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { forwardTwilioConnectActionWebhook } from "../../runtime/client.js";
import { validateTwilioWebhookRequest } from "../../twilio/validate-webhook.js";

const log = getLogger("twilio-connect-action-webhook");

export function createTwilioConnectActionWebhookHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    const validation = await validateTwilioWebhookRequest(req, config);
    if (validation instanceof Response) return validation;

    const { params } = validation;
    log.info("Twilio connect-action webhook received");

    try {
      const runtimeResponse = await forwardTwilioConnectActionWebhook(config, params);
      return new Response(runtimeResponse.body, {
        status: runtimeResponse.status,
        headers: runtimeResponse.headers,
      });
    } catch (err) {
      log.error({ err }, "Failed to forward Twilio connect-action webhook to runtime");
      return Response.json({ error: "Internal server error" }, { status: 502 });
    }
  };
}
