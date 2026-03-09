import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import {
  CircuitBreakerOpenError,
  forwardTwilioStatusWebhook,
} from "../../runtime/client.js";
import {
  validateTwilioWebhookRequest,
  type TwilioValidationCaches,
} from "../../twilio/validate-webhook.js";

const log = getLogger("twilio-status-webhook");

export function createTwilioStatusWebhookHandler(
  config: GatewayConfig,
  caches?: TwilioValidationCaches,
) {
  return async (req: Request): Promise<Response> => {
    const validation = await validateTwilioWebhookRequest(req, config, caches);
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
      if (err instanceof CircuitBreakerOpenError) {
        return Response.json(
          { error: "Service temporarily unavailable" },
          {
            status: 503,
            headers: { "Retry-After": String(err.retryAfterSecs) },
          },
        );
      }
      log.error({ err }, "Failed to forward Twilio status webhook to runtime");
      return Response.json({ error: "Internal server error" }, { status: 502 });
    }
  };
}
