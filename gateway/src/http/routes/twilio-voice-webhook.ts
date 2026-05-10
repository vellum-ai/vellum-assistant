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
import { ContactStore } from "../../db/contact-store.js";

const log = getLogger("twilio-voice-webhook");

/** TwiML that rejects the call — Twilio plays a busy signal and hangs up. */
const REJECT_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>';

const TWIML_HEADERS = { "Content-Type": "text/xml" };

/** Escapes XML special characters so contact display names are safe to embed in TwiML. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

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

      // ── Known-but-unverified caller guidance ─────────────────────────────
      // If the caller's number is registered under a contact's phone channel
      // but has not yet passed DTMF verification, intercept with a helpful
      // message rather than letting the runtime treat them as an unknown caller.
      if (params.From) {
        try {
          const callerRecord = new ContactStore().getContactByPhoneNumber(
            params.From,
          );
          // Only intercept genuinely unverified channels — not blocked ones.
          // A blocked caller should fall through to the runtime's deny path
          // rather than hearing a helpful verification script (which would
          // both leak the contact name and weaken block semantics).
          // The display name is intentionally included: the caller registered
          // this number themselves, so disclosing their own name is expected.
          const unverifiedStatuses = new Set(["unverified", "pending"]);
          if (callerRecord && unverifiedStatuses.has(callerRecord.channel.status)) {
            const isGuardian = callerRecord.contact.role === "guardian";
            log.info(
              {
                callSid: params.CallSid,
                contactId: callerRecord.contact.id,
                channelStatus: callerRecord.channel.status,
                isGuardian,
              },
              "Known-but-unverified caller — returning verification guidance TwiML",
            );
            const name = escapeXml(callerRecord.contact.displayName);
            // Conditional guidance: only the guardian has direct access to the
            // assistant's contacts page; other contacts must ask the guardian
            // to (re)start a verification session for them.
            const action = isGuardian
              ? `To verify, open your assistant's contacts page, click Verify next to the phone channel, ` +
                `and follow the prompts. Then call back once the verification session is active.`
              : `Please reach out to the account guardian to start a new verification session, ` +
                `then call back once the verification session is active.`;
            const twiml =
              `<?xml version="1.0" encoding="UTF-8"?><Response>` +
              `<Say>This number is registered as ${name}'s phone but has not been verified yet. ` +
              `${action}</Say>` +
              `</Response>`;
            return new Response(twiml, { status: 200, headers: TWIML_HEADERS });
          }
        } catch (err) {
          log.warn(
            { err, callSid: params.CallSid },
            "Failed to check unverified caller — falling through to assistant",
          );
        }
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
