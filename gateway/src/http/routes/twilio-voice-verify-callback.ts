/**
 * POST /webhooks/twilio/voice-verify — Twilio <Gather> action callback
 * for gateway-owned voice verification.
 *
 * When the gateway intercepts an inbound call that requires verification,
 * it returns <Gather> TwiML pointing to this endpoint. Twilio POSTs the
 * collected DTMF digits here. The gateway validates the code, creates
 * the guardian binding on success, and then forwards to the assistant
 * for ConversationRelay setup.
 *
 * The assistant is never involved in verification — it only receives
 * calls from callers whose identity the gateway has already confirmed.
 */

import { eq } from "drizzle-orm";

import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import {
  CircuitBreakerOpenError,
  forwardTwilioVoiceWebhook,
} from "../../runtime/client.js";
import {
  validateTwilioWebhookRequest,
  type TwilioValidationCaches,
} from "../../twilio/validate-webhook.js";
import {
  findPendingPhoneSession,
  validateVerificationCode,
  gatherVerificationTwiml,
  failureTwiml,
} from "../../voice/verification.js";
import { createGuardianBinding } from "../../auth/guardian-bootstrap.js";
import { getGatewayDb } from "../../db/connection.js";
import { contactChannels as gwContactChannels } from "../../db/schema.js";
import {
  assistantDbQuery,
  assistantDbRun,
} from "../../db/assistant-db-proxy.js";
import { upsertVerifiedContactChannel } from "../../verification/contact-helpers.js";

const log = getLogger("twilio-voice-verify-callback");

const TWIML_HEADERS = { "Content-Type": "text/xml" };

function twimlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: TWIML_HEADERS });
}

export function createTwilioVoiceVerifyCallbackHandler(
  config: GatewayConfig,
  caches?: TwilioValidationCaches,
) {
  return async (req: Request): Promise<Response> => {
    const validation = await validateTwilioWebhookRequest(req, config, caches);
    if (validation instanceof Response) return validation;

    const { params } = validation;
    const fromNumber = params.From || "";
    const callSid = params.CallSid || "";

    // Extract attempt counter from query string
    const url = new URL(req.url);
    const attempt = parseInt(url.searchParams.get("attempt") || "0", 10);
    const digits = params.Digits || "";

    log.info(
      { callSid, fromNumber, attempt, hasDigits: digits.length > 0 },
      "Voice verification callback received",
    );

    // Re-fetch the pending session (it may have been consumed or expired)
    const session = await findPendingPhoneSession();
    if (!session) {
      log.warn(
        { callSid, fromNumber },
        "No pending verification session found on callback — forwarding to assistant",
      );
      return forwardToAssistant(config, params, req.url);
    }

    if (!digits) {
      log.info(
        { callSid, fromNumber },
        "No digits entered — re-prompting",
      );
      const actionUrl = buildActionUrl(url, attempt);
      return twimlResponse(
        gatherVerificationTwiml(actionUrl, attempt, session.codeDigits ?? 6),
      );
    }

    // Validate the entered code
    const result = await validateVerificationCode(
      session,
      digits,
      fromNumber,
      attempt,
    );

    if (!result.success) {
      if (result.exhausted) {
        log.warn(
          { callSid, fromNumber, attempt },
          "Voice verification exhausted — hanging up",
        );
        return twimlResponse(failureTwiml(result.failureMessage!));
      }

      // Re-prompt with incremented attempt
      const nextAttempt = attempt + 1;
      const actionUrl = buildActionUrl(url, nextAttempt);
      return twimlResponse(
        gatherVerificationTwiml(actionUrl, nextAttempt, session.codeDigits ?? 6),
      );
    }

    // Verification succeeded — create guardian binding if this is a guardian verification
    if (result.verificationType === "guardian") {
      try {
        // Resolve the canonical principal from the vellum channel guardian binding
        const vellumGuardians = await assistantDbQuery<{
          principalId: string | null;
        }>(
          `SELECT c.principal_id AS principalId
           FROM contacts c
           JOIN contact_channels cc ON cc.contact_id = c.id
           WHERE c.role = 'guardian' AND cc.type = 'vellum' AND cc.status = 'active'
           LIMIT 1`,
          [],
        );
        const canonicalPrincipal =
          vellumGuardians[0]?.principalId ?? fromNumber;

        // Check for existing phone guardian binding conflict
        const existingPhoneGuardians = await assistantDbQuery<{
          externalUserId: string | null;
        }>(
          `SELECT cc.external_user_id AS externalUserId
           FROM contacts c
           JOIN contact_channels cc ON cc.contact_id = c.id
           WHERE c.role = 'guardian' AND cc.type = 'phone' AND cc.status = 'active'
           LIMIT 1`,
          [],
        );

        const existingGuardian = existingPhoneGuardians[0];
        if (existingGuardian && existingGuardian.externalUserId !== fromNumber) {
          log.warn(
            {
              callSid,
              fromNumber,
              existingGuardian: existingGuardian.externalUserId,
            },
            "Guardian binding conflict — another user already holds the voice binding",
          );
        } else {
          // Revoke existing phone guardian binding before creating new one
          if (existingGuardian) {
            await revokeExistingPhoneGuardian();
          }

          await createGuardianBinding({
            channel: "phone",
            externalUserId: fromNumber,
            deliveryChatId: fromNumber,
            guardianPrincipalId: canonicalPrincipal,
            verifiedVia: "challenge",
          });

          log.info(
            { callSid, fromNumber, canonicalPrincipal },
            "Guardian phone binding created by gateway",
          );
        }
      } catch (err) {
        log.error(
          { err, callSid, fromNumber },
          "Failed to create guardian binding after voice verification",
        );
        // Don't fail the call — the verification succeeded even if binding
        // creation had an issue. The caller should still be connected.
      }
    } else if (result.verificationType === "trusted_contact") {
      try {
        await upsertVerifiedContactChannel({
          sourceChannel: "phone",
          externalUserId: fromNumber,
          externalChatId: fromNumber,
        });

        log.info(
          { callSid, fromNumber },
          "Trusted contact phone channel activated by gateway",
        );
      } catch (err) {
        log.error(
          { err, callSid, fromNumber },
          "Failed to upsert trusted contact channel after voice verification",
        );
      }
    }

    // Forward to the assistant for ConversationRelay setup.
    // The assistant will see the caller as already verified.
    log.info(
      { callSid, fromNumber },
      "Voice verification complete — forwarding to assistant for call setup",
    );
    return forwardToAssistant(config, params, req.url);
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Revoke the existing phone guardian binding by setting status to 'revoked'.
 * Dual-writes to both assistant DB and gateway DB.
 */
async function revokeExistingPhoneGuardian(): Promise<void> {
  const now = Date.now();

  const revokedRows = await assistantDbQuery<{ id: string }>(
    `SELECT cc.id
     FROM contacts c
     JOIN contact_channels cc ON cc.contact_id = c.id
     WHERE c.role = 'guardian' AND cc.type = 'phone' AND cc.status = 'active'`,
    [],
  );

  if (revokedRows.length === 0) return;

  const ids = revokedRows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(", ");

  await assistantDbRun(
    `UPDATE contact_channels
     SET status = 'revoked', policy = 'deny', updated_at = ?
     WHERE id IN (${placeholders})`,
    [now, ...ids],
  );

  // Gateway DB dual-write (best-effort)
  try {
    const gwDb = getGatewayDb();
    for (const id of ids) {
      gwDb.update(gwContactChannels)
        .set({ status: "revoked", policy: "deny", updatedAt: now })
        .where(eq(gwContactChannels.id, id))
        .run();
    }
  } catch (gwErr) {
    log.warn({ err: gwErr }, "Gateway DB revoke dual-write failed (best-effort)");
  }
}

/**
 * Build the action URL for the next Gather attempt, preserving the base
 * path and incrementing the attempt counter.
 */
function buildActionUrl(currentUrl: URL, attempt: number): string {
  const actionUrl = new URL(currentUrl.origin + currentUrl.pathname);
  actionUrl.searchParams.set("attempt", String(attempt));
  return actionUrl.pathname + actionUrl.search;
}

/**
 * Forward the Twilio voice webhook to the assistant runtime and return
 * the TwiML response (with relay token injection handled by the client).
 */
async function forwardToAssistant(
  config: GatewayConfig,
  params: Record<string, string>,
  originalUrl: string,
): Promise<Response> {
  try {
    const runtimeResponse = await forwardTwilioVoiceWebhook(
      config,
      params,
      originalUrl,
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
    log.error({ err }, "Failed to forward voice webhook to runtime after verification");
    return Response.json({ error: "Internal server error" }, { status: 502 });
  }
}
