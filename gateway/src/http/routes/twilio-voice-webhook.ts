import type { ConfigFileCache } from "../../config-file-cache.js";
import type { GatewayConfig } from "../../config.js";
import { credentialKey } from "../../credential-key.js";
import { getLogger } from "../../logger.js";
import {
  CircuitBreakerOpenError,
  forwardTwilioVoiceWebhook,
  resolvePublicBaseWssUrl,
} from "../../runtime/client.js";
import {
  resolveAssistant,
  resolveAssistantByPhoneNumber,
  isRejection,
} from "../../routing/resolve-assistant.js";
import {
  validateTwilioWebhookRequest,
  type TwilioValidationCaches,
} from "../../twilio/validate-webhook.js";
import {
  findPendingPhoneSession,
  gatherVerificationTwiml,
} from "../../voice/verification.js";

const log = getLogger("twilio-voice-webhook");

/** TwiML that rejects the call — Twilio plays a busy signal and hangs up. */
const REJECT_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>';

const TWIML_HEADERS = { "Content-Type": "text/xml" };

export function createTwilioVoiceWebhookHandler(
  config: GatewayConfig,
  caches?: TwilioValidationCaches & { configFile?: ConfigFileCache },
) {
  return async (req: Request): Promise<Response> => {
    const validation = await validateTwilioWebhookRequest(req, config, caches);
    if (validation instanceof Response) return validation;

    const { params } = validation;
    log.info({ callSid: params.CallSid }, "Twilio voice webhook received");

    // For inbound calls (no callSessionId in the URL), resolve the assistant
    // by the "To" phone number, then fall through to the standard routing
    // chain (defaultAssistantId / unmapped policy).
    const url = new URL(req.url);
    const hasCallSessionId = !!url.searchParams.get("callSessionId");
    let assistantId: string | undefined;

    if (!hasCallSessionId) {
      const phoneRouting = params.To
        ? resolveAssistantByPhoneNumber(config, params.To, caches?.configFile)
        : undefined;

      if (phoneRouting && "assistantId" in phoneRouting) {
        assistantId = phoneRouting.assistantId;
        log.info(
          { assistantId, toNumber: params.To },
          "Resolved assistant by phone number for inbound call",
        );
      } else {
        // Phone-number lookup missed — fall through to standard routing so
        // defaultAssistantId / unmapped policy is respected, instead of
        // silently forwarding with no assistant ID.
        const fallbackRouting = resolveAssistant(
          config,
          params.From || "",
          params.From || "",
        );

        if (isRejection(fallbackRouting)) {
          log.warn(
            {
              from: params.From,
              to: params.To,
              reason: fallbackRouting.reason,
            },
            "Inbound voice call rejected by routing — no phone number match and unmapped policy rejects",
          );
          return new Response(REJECT_TWIML, {
            status: 200,
            headers: TWIML_HEADERS,
          });
        }

        assistantId = fallbackRouting.assistantId;
        log.info(
          {
            assistantId,
            routeSource: fallbackRouting.routeSource,
            from: params.From,
          },
          "Resolved assistant via fallback routing for inbound call",
        );
      }

      // ── Gateway-owned voice verification ────────────────────────────
      // For inbound calls, check if there's a pending phone verification
      // session. If so, intercept the call with a <Gather> TwiML flow
      // instead of forwarding to the assistant. The assistant never
      // touches verification — it only receives verified calls.
      try {
        const pendingSession = await findPendingPhoneSession();
        if (pendingSession) {
          log.info(
            {
              callSid: params.CallSid,
              fromNumber: params.From,
              sessionId: pendingSession.id,
            },
            "Pending phone verification session found — intercepting with gateway verification",
          );
          const verifyCallbackPath = `/webhooks/twilio/voice-verify?attempt=0`;
          const codeDigits = pendingSession.codeDigits ?? 6;
          return new Response(
            gatherVerificationTwiml(verifyCallbackPath, 0, codeDigits),
            { status: 200, headers: TWIML_HEADERS },
          );
        }
      } catch (err) {
        log.warn(
          { err, callSid: params.CallSid },
          "Failed to check pending verification session — falling through to assistant",
        );
      }
    }

    try {
      const platformAssistantId = (
        await caches?.credentials?.get(
          credentialKey("vellum", "platform_assistant_id"),
        )
      )?.trim();
      const runtimeResponse = await forwardTwilioVoiceWebhook(
        config,
        params,
        req.url,
        resolvePublicBaseWssUrl(config, caches?.configFile, platformAssistantId),
      );
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
      log.error({ err }, "Failed to forward Twilio voice webhook to runtime");
      return Response.json({ error: "Internal server error" }, { status: 502 });
    }
  };
}
