/**
 * HTTP route handlers for Twilio voice webhooks.
 *
 * - handleVoiceWebhook: initial voice webhook; returns TwiML to connect ConversationRelay
 * - handleStatusCallback: call status updates (ringing, in-progress, completed, etc.)
 * - handleConnectAction: called when the ConversationRelay connection ends
 */

import { loadConfig } from "../config/loader.js";
import { getTwilioRelayUrl } from "../inbound/public-ingress-urls.js";
import { mintEdgeRelayToken } from "../runtime/auth/token-service.js";
import { getLogger } from "../util/logger.js";
import { persistCallCompletionMessage } from "./call-conversation-messages.js";
import { createInboundVoiceSession } from "./call-domain.js";
import { logDeadLetterEvent } from "./call-recovery.js";
import { fireCallCompletionNotifier } from "./call-state.js";
import { isTerminalState } from "./call-state-machine.js";
import {
  buildCallbackDedupeKey,
  claimCallback,
  expirePendingQuestions,
  finalizeCallbackClaim,
  getCallSession,
  getCallSessionByCallSid,
  recordCallEvent,
  releaseCallbackClaim,
  updateCallSession,
} from "./call-store.js";
import type { CallStatus } from "./types.js";
import { resolveVoiceQualityProfile } from "./voice-quality.js";

const log = getLogger("twilio-routes");

// ── Helpers ──────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function generateTwiML(
  callSessionId: string,
  relayUrl: string,
  welcomeGreeting: string | null,
  profile: {
    language: string;
    transcriptionProvider: string;
    ttsProvider: string;
    voice: string;
  },
  relayToken?: string,
  customParameters?: Record<string, string>,
): string {
  const greetingAttr =
    welcomeGreeting && welcomeGreeting.trim().length > 0
      ? `\n      welcomeGreeting="${escapeXml(welcomeGreeting.trim())}"`
      : "";
  const tokenParam = relayToken
    ? `&amp;token=${escapeXml(encodeURIComponent(relayToken))}`
    : "";

  // Build <Parameter> elements for custom parameters to propagate
  // through the ConversationRelay setup payload for observability.
  let parameterElements = "";
  if (customParameters) {
    for (const [key, value] of Object.entries(customParameters)) {
      parameterElements += `\n      <Parameter name="${escapeXml(
        key,
      )}" value="${escapeXml(value)}" />`;
    }
  }

  // When there are no Parameter children, use self-closing tag to preserve
  // the original TwiML format. With children, use open/close tags.
  const hasParameters = parameterElements.length > 0;
  const relayClose = hasParameters
    ? `>${parameterElements}\n    </ConversationRelay>`
    : "/>";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${escapeXml(relayUrl)}?callSessionId=${escapeXml(
        callSessionId,
      )}${tokenParam}"
${greetingAttr}
      voice="${escapeXml(profile.voice)}"
      language="${escapeXml(profile.language)}"
      transcriptionProvider="${escapeXml(profile.transcriptionProvider)}"
      ttsProvider="${escapeXml(profile.ttsProvider)}"
      interruptible="true"
      dtmfDetection="true"
    ${relayClose}
  </Connect>
</Response>`;
}

export function buildWelcomeGreeting(
  task: string | null,
  configuredGreeting?: string,
): string {
  void task;
  const override = configuredGreeting?.trim();
  if (override) return override;
  // The contextual first opener now comes from the call controller's
  // initial LLM turn via the session pipeline. Keep Twilio's relay-level
  // greeting empty by default so we don't speak a deterministic static line first.
  return "";
}

/**
 * Map Twilio call status strings to our internal CallStatus.
 */
function mapTwilioStatus(twilioStatus: string): CallStatus | null {
  switch (twilioStatus) {
    case "initiated":
    case "queued":
      return "initiated";
    case "ringing":
      return "ringing";
    case "answered":
    case "in-progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
    case "busy":
    case "no-answer":
    case "canceled":
      return "failed";
    default:
      return null;
  }
}

// ── Route handlers ───────────────────────────────────────────────────

/**
 * Receives the initial voice webhook when Twilio connects the call.
 * Returns TwiML XML that tells Twilio to open a ConversationRelay WebSocket.
 *
 * Supports two flows:
 * - **Outbound** (callSessionId present in query): uses the existing session
 * - **Inbound** (callSessionId absent): creates or reuses a session keyed
 *   by the Twilio CallSid. Uses daemon internal scope for assistant identity.
 */
export async function handleVoiceWebhook(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const callSessionId = url.searchParams.get("callSessionId");

  // Parse the Twilio POST body to capture CallSid and caller metadata.
  const formBody = new URLSearchParams(await req.text());
  const callSid = formBody.get("CallSid");
  const callerFrom = formBody.get("From") ?? "";
  const callerTo = formBody.get("To") ?? "";

  // ── Inbound mode: no callSessionId in query ─────────────────────
  if (!callSessionId) {
    if (!callSid) {
      log.warn("Inbound voice webhook called without CallSid");
      return new Response("Missing CallSid", { status: 400 });
    }

    log.info(
      { callSid, from: callerFrom, to: callerTo },
      "Inbound voice webhook — creating/reusing session",
    );

    const { session } = createInboundVoiceSession({
      callSid,
      fromNumber: callerFrom,
      toNumber: callerTo,
    });

    return buildVoiceWebhookTwiml(
      session.id,
      session.task,
      session.verificationSessionId,
    );
  }

  // ── Outbound mode: callSessionId is present ─────────────────────
  const session = getCallSession(callSessionId);
  if (!session) {
    log.warn({ callSessionId }, "Voice webhook: call session not found");
    return new Response("Call session not found", { status: 404 });
  }

  if (isTerminalState(session.status)) {
    log.warn(
      { callSessionId, status: session.status },
      "Voice webhook: call session is in terminal state",
    );
    return new Response("Call session is no longer active", { status: 410 });
  }

  // Capture CallSid immediately so status callbacks can locate this session
  if (callSid && callSid !== session.providerCallSid) {
    updateCallSession(callSessionId, { providerCallSid: callSid });
    log.info({ callSessionId, callSid }, "Stored CallSid from voice webhook");
  }

  return buildVoiceWebhookTwiml(
    callSessionId,
    session.task,
    session.verificationSessionId,
  );
}

/**
 * Shared TwiML generation for both inbound and outbound voice webhooks.
 * Resolves voice quality profile, relay URL, and welcome greeting,
 * then returns a Response with the generated TwiML.
 *
 * When `verificationSessionId` is provided, it is included as a
 * `<Parameter>` in the TwiML for observability and compatibility with
 * the Twilio setup payload. The persisted call session mode is the
 * primary signal for deterministic flow selection in the relay server.
 */
function buildVoiceWebhookTwiml(
  callSessionId: string,
  task: string | null,
  verificationSessionId?: string | null,
): Response {
  const profile = resolveVoiceQualityProfile(loadConfig());

  log.info(
    { callSessionId, ttsProvider: profile.ttsProvider, voice: profile.voice },
    "Voice quality profile resolved",
  );

  const relayUrl = getTwilioRelayUrl(loadConfig());
  const welcomeGreeting = buildWelcomeGreeting(task);

  const relayToken = mintEdgeRelayToken();

  // Propagate verificationSessionId as a TwiML <Parameter> for
  // observability. This is not the sole source of truth; the relay
  // server reads the persisted call_mode from the call session first.
  const customParameters: Record<string, string> | undefined =
    verificationSessionId ? { verificationSessionId } : undefined;

  const twiml = generateTwiML(
    callSessionId,
    relayUrl,
    welcomeGreeting,
    profile,
    relayToken,
    customParameters,
  );

  log.info({ callSessionId }, "Returning ConversationRelay TwiML");

  return new Response(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

/**
 * Receives call status updates from Twilio (POST with form-urlencoded body).
 * Updates the call session status and records events.
 */
export async function handleStatusCallback(req: Request): Promise<Response> {
  const formBody = new URLSearchParams(await req.text());
  const callSid = formBody.get("CallSid");
  const callStatus = formBody.get("CallStatus");

  if (!callSid || !callStatus) {
    const rawPayload = Object.fromEntries(formBody.entries());
    logDeadLetterEvent(
      "Status callback missing CallSid or CallStatus",
      rawPayload,
      log,
    );
    return new Response(null, { status: 200 });
  }

  log.info({ callSid, callStatus }, "Twilio status callback received");

  const session = getCallSessionByCallSid(callSid);
  if (!session) {
    log.warn(
      { callSid, callStatus },
      "Status callback: no call session found for CallSid",
    );
    return new Response(null, { status: 200 });
  }

  const mappedStatus = mapTwilioStatus(callStatus);
  if (!mappedStatus) {
    const rawPayload = Object.fromEntries(formBody.entries());
    logDeadLetterEvent(`Unknown Twilio status: ${callStatus}`, rawPayload, log);
    return new Response(null, { status: 200 });
  }

  // ── Atomic idempotency claim ────────────────────────────────────
  const timestamp = formBody.get("Timestamp");
  const sequenceNumber = formBody.get("SequenceNumber");
  const dedupeKey = buildCallbackDedupeKey(
    callSid,
    callStatus,
    timestamp,
    sequenceNumber,
  );

  const claimId = claimCallback(dedupeKey, session.id);
  if (!claimId) {
    log.info(
      { callSid, callStatus, dedupeKey },
      "Duplicate status callback — skipping",
    );
    return new Response(null, { status: 200 });
  }

  let eventPersisted = false;
  try {
    const wasTerminal = isTerminalState(session.status);

    // Build updates
    const updates: Parameters<typeof updateCallSession>[1] = {
      status: mappedStatus,
    };

    if (mappedStatus === "in_progress" && !session.startedAt) {
      updates.startedAt = Date.now();
    }

    const isTerminal =
      mappedStatus === "completed" || mappedStatus === "failed";
    if (isTerminal) {
      updates.endedAt = Date.now();
    }

    const eventType = isTerminal
      ? mappedStatus === "completed"
        ? "call_ended"
        : "call_failed"
      : mappedStatus === "in_progress"
        ? "call_connected"
        : "call_started";

    // Record event after DB update but before lease sync: avoids duplicate
    // events on retry (if update fails we never record), while ensuring the
    // lease is only released after persistence so vellum sleep doesn't proceed
    // before the call is fully recorded.
    updateCallSession(session.id, updates, {
      beforeLeaseSync: () => {
        recordCallEvent(session.id, eventType, {
          twilioStatus: callStatus,
          callSid,
        });
        eventPersisted = true;
      },
    });

    // Post-persistence processing is best-effort — failures must not
    // propagate to the outer catch block, which would incorrectly treat
    // them as lease-sync failures and finalize the dedupe claim.
    try {
      if (isTerminal) {
        expirePendingQuestions(session.id);

        if (!wasTerminal) {
          persistCallCompletionMessage(
            session.conversationId,
            session.id,
          ).catch((err) => {
            log.error(
              {
                err,
                conversationId: session.conversationId,
                callSessionId: session.id,
              },
              "Failed to persist call completion message",
            );
          });
          fireCallCompletionNotifier(session.conversationId, session.id);
        }
      }
    } catch (postErr) {
      log.error(
        { err: postErr, callSid, callStatus, callSessionId: session.id },
        "Post-persistence processing failed — event and claim are intact, but side effects may be incomplete",
      );
    }

    // Mark the claim as permanently processed so it never expires.
    // If finalization returns false, another handler reclaimed this key
    // after our claim expired — our business writes already landed but
    // the dedupe row now belongs to the other handler, risking duplicate
    // processing on later retries.
    const finalized = finalizeCallbackClaim(dedupeKey, claimId);
    if (!finalized) {
      log.warn(
        { dedupeKey, claimId, callSid, callStatus },
        "Lost claim during finalization — business writes committed but dedupe ownership was taken by another handler",
      );
    }
  } catch (err) {
    if (eventPersisted) {
      // Event already written — releasing the claim would let Twilio
      // retries insert a duplicate event. Finalize instead so the
      // dedupe guard blocks subsequent attempts.
      try {
        finalizeCallbackClaim(dedupeKey, claimId);
        log.warn(
          { dedupeKey, claimId, callSid, callStatus, err },
          "Post-persistence error — claim finalized to prevent duplicate events on retry",
        );
      } catch (finalizeErr) {
        log.error(
          { dedupeKey, claimId, callSid, callStatus, finalizeErr },
          "Failed to finalize claim after event persistence — original error will still be re-thrown",
        );
      }
    } else {
      // Nothing persisted yet — safe to release so retries can reprocess
      try {
        releaseCallbackClaim(dedupeKey, claimId);
      } catch (releaseErr) {
        log.error(
          { dedupeKey, claimId, callSid, callStatus, releaseErr },
          "Failed to release claim — original error will still be re-thrown",
        );
      }
    }
    throw err;
  }

  return new Response(null, { status: 200 });
}

/**
 * Called when the ConversationRelay connection ends.
 * Returns empty TwiML to acknowledge.
 */
export async function handleConnectAction(_req: Request): Promise<Response> {
  log.info("ConversationRelay connect-action callback received");
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
