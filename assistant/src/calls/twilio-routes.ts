/**
 * HTTP route handlers for Twilio voice webhooks.
 *
 * - handleVoiceWebhook: initial voice webhook; returns `<Connect><Stream>`
 *   TwiML so the daemon receives raw audio over the media-stream transport
 *   and performs STT/TTS server-side for every call
 * - handleStatusCallback: call status updates (ringing, in-progress, completed, etc.)
 * - handleConnectAction: called when the ConversationRelay connection ends
 *
 * Setup-flow routing (verification, invite redemption, name capture, deny,
 * normal) is resolved by the media-stream server when Twilio's `start`
 * frame arrives — TwiML generation performs no routing of its own. Its
 * only gate is the STT+TTS credential-readiness preflight: a call whose
 * daemon cannot transcribe or speak gets audible `<Say>` setup-required
 * TwiML and a `<Hangup/>` instead of a doomed stream.
 */

import {
  buildTwilioMediaStreamUrl,
  TWILIO_PUBLIC_BASE_URL_PLACEHOLDER,
} from "@vellumai/service-contracts/twilio-ingress";

import {
  BadRequestError,
  GoneError,
  NotFoundError,
  RouteError,
} from "../runtime/routes/errors.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";
import { RouteResponse } from "../runtime/routes/types.js";
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
import { resolveTelephonyCredentialReadiness } from "./telephony-credential-preflight.js";
import type { CallStatus } from "./types.js";

const log = getLogger("twilio-routes");

/**
 * Sentinel placeholder embedded in TwiML where the relay auth token should go.
 * The gateway replaces this with a real JWT before returning TwiML to Twilio.
 * This keeps the signing key out of the daemon for voice webhook responses.
 */
const TWILIO_RELAY_TOKEN_PLACEHOLDER = "__VELLUM_RELAY_TOKEN__";

// ── TwiML generation ─────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generate `<Connect><Stream>` TwiML for the media-stream transport.
 *
 * Twilio opens a WebSocket to `streamUrl` and sends raw audio frames; the
 * daemon transcribes and synthesizes speech server-side.
 *
 * `callSessionId` and `token` are encoded as **path segments** on the
 * WebSocket URL so the gateway can validate and route the upgrade request
 * before any Twilio `start` frame arrives. Twilio Media Streams does not
 * reliably preserve URL query parameters across the WebSocket upgrade, so
 * path-based encoding is the primary transport for handshake metadata.
 *
 * Both values are also propagated as `<Parameter>` children so Twilio
 * includes them in the `start` event's `customParameters` object for
 * downstream observability.
 */
export function generateStreamTwiML(
  callSessionId: string,
  streamUrl: string,
  relayToken?: string,
  customParameters?: Record<string, string>,
): string {
  // Build the WebSocket URL with callSessionId and token as path segments.
  // Twilio Media Streams does not reliably preserve query parameters
  // across the WebSocket upgrade, so path-based encoding is the primary
  // transport. The gateway extracts metadata from path segments first,
  // falling back to query parameters for legacy compatibility.
  let fullStreamUrl = streamUrl.replace(/\/+$/, "");
  fullStreamUrl += `/${encodeURIComponent(callSessionId)}`;
  if (relayToken) {
    fullStreamUrl += `/${encodeURIComponent(relayToken)}`;
  }

  // Build <Parameter> elements for the Twilio start event payload.
  // Spread customParameters first so callSessionId and token cannot be
  // overridden by caller-supplied values.
  const allParams: Record<string, string> = {
    ...customParameters,
    callSessionId,
  };

  if (relayToken) {
    allParams.token = relayToken;
  }

  let parameterElements = "";
  for (const [key, value] of Object.entries(allParams)) {
    parameterElements += `\n      <Parameter name="${escapeXml(key)}" value="${escapeXml(value)}" />`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(fullStreamUrl)}">${parameterElements}
    </Stream>
  </Connect>
</Response>`;
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

// ── Helpers ──────────────────────────────────────────────────────────

/** Wrap a TwiML string in an HTTP Response with XML content-type. */
function twimlResponse(twiml: string): Response {
  return new Response(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

const TWIML_HEADERS = { "Content-Type": "text/xml" } as const;

// ── Core voice webhook logic ─────────────────────────────────────────

/**
 * Core voice webhook logic — transport-agnostic.
 *
 * Accepts pre-parsed form params and an optional callSessionId (from URL
 * query for outbound calls). Returns a TwiML string. Throws RouteError
 * subclasses on failure.
 */
async function processVoiceWebhook(
  params: Record<string, string>,
  callSessionId: string | null,
): Promise<string> {
  const callSid = params.CallSid ?? null;
  const callerFrom = params.From ?? "";
  const callerTo = params.To ?? "";

  // ── Inbound mode: no callSessionId ──────────────────────────────
  if (!callSessionId) {
    if (!callSid) {
      log.warn("Inbound voice webhook called without CallSid");
      throw new BadRequestError("Missing CallSid");
    }

    log.info(
      { callSid, from: callerFrom, to: callerTo },
      "Inbound voice webhook — creating/reusing session",
    );

    const { session } = await createInboundVoiceSession({
      callSid,
      fromNumber: callerFrom,
      toNumber: callerTo,
    });

    return buildVoiceWebhookTwiml(session.id, session.verificationSessionId);
  }

  // ── Outbound mode: callSessionId is present ─────────────────────
  const session = getCallSession(callSessionId);
  if (!session) {
    log.warn({ callSessionId }, "Voice webhook: call session not found");
    throw new NotFoundError("Call session not found");
  }

  if (isTerminalState(session.status)) {
    log.warn(
      { callSessionId, status: session.status },
      "Voice webhook: call session is in terminal state",
    );
    throw new GoneError("Call session is no longer active");
  }

  // Capture CallSid immediately so status callbacks can locate this session
  if (callSid && callSid !== session.providerCallSid) {
    updateCallSession(callSessionId, { providerCallSid: callSid });
    log.info({ callSessionId, callSid }, "Stored CallSid from voice webhook");
  }

  return buildVoiceWebhookTwiml(callSessionId, session.verificationSessionId);
}

// ── Route handlers ───────────────────────────────────────────────────

/**
 * Receives the initial voice webhook when Twilio connects the call.
 * Returns TwiML XML that tells Twilio to open a media-stream WebSocket.
 *
 * Supports two flows:
 * - **Outbound** (callSessionId present in query): uses the existing session
 * - **Inbound** (callSessionId absent): creates or reuses a session keyed
 *   by the Twilio CallSid. Uses daemon internal scope for assistant identity.
 */
export async function handleVoiceWebhook(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const callSessionId = url.searchParams.get("callSessionId");

  const formBody = new URLSearchParams(await req.text());
  const params = Object.fromEntries(formBody.entries());

  try {
    return twimlResponse(await processVoiceWebhook(params, callSessionId));
  } catch (err) {
    if (err instanceof RouteError) {
      return new Response(err.message, { status: err.statusCode });
    }
    throw err;
  }
}

/**
 * Shared TwiML generation for both inbound and outbound voice webhooks.
 *
 * Every call connects over the media-stream transport. Setup-flow routing
 * (`routeSetup`) is owned by the media-stream server, which resolves it
 * when Twilio's `start` frame arrives — no routing happens at TwiML time.
 *
 * The one TwiML-time gate is credential readiness: the daemon performs
 * both STT and TTS on this transport, so when
 * {@link resolveTelephonyCredentialReadiness} reports a gap the webhook
 * returns `<Say>` setup-required copy plus `<Hangup/>` (audible via
 * Twilio-hosted TTS even when the daemon's TTS is the broken half) and
 * records a `telephony_credential_preflight_failed` call event instead of
 * connecting a stream that cannot work.
 *
 * When `verificationSessionId` is provided, it is included as a
 * `<Parameter>` in the TwiML for observability and compatibility with
 * the Twilio setup payload. The persisted call session mode is the
 * primary signal for deterministic flow selection at stream start.
 */
async function buildVoiceWebhookTwiml(
  callSessionId: string,
  verificationSessionId?: string | null,
): Promise<string> {
  const readiness = await resolveTelephonyCredentialReadiness();
  if (readiness.status === "not-ready") {
    log.warn(
      { callSessionId, missing: readiness.missing },
      "Telephony credential preflight failed — returning setup-required TwiML",
    );
    recordCallEvent(callSessionId, "telephony_credential_preflight_failed", {
      missing: readiness.missing,
    });
    return buildSetupRequiredTwiml(readiness.userMessage);
  }

  return buildMediaStreamTwiml(callSessionId, verificationSessionId);
}

/**
 * Build `<Say>` + `<Hangup/>` TwiML for calls blocked by the credential
 * preflight, so the caller hears why the call cannot proceed.
 */
function buildSetupRequiredTwiml(userMessage: string): string {
  const sayCopy = `${userMessage} Please finish voice setup and call again. Goodbye.`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${escapeXml(sayCopy)}</Say>
  <Hangup/>
</Response>`;
}

/**
 * Build Stream TwiML connecting the call to the daemon's media-stream server.
 */
function buildMediaStreamTwiml(
  callSessionId: string,
  verificationSessionId: string | null | undefined,
): string {
  const streamUrl = buildTwilioMediaStreamUrl(
    TWILIO_PUBLIC_BASE_URL_PLACEHOLDER,
  );
  const relayToken = TWILIO_RELAY_TOKEN_PLACEHOLDER;

  const customParameters: Record<string, string> | undefined =
    verificationSessionId ? { verificationSessionId } : undefined;

  const twiml = generateStreamTwiML(
    callSessionId,
    streamUrl,
    relayToken,
    customParameters,
  );

  log.info({ callSessionId }, "Returning Stream TwiML");

  return twiml;
}

/**
 * Core status callback logic — transport-agnostic.
 *
 * Accepts pre-parsed form params. Returns void (always 200 to Twilio
 * regardless of internal state — errors are logged, not surfaced).
 */
function processStatusCallback(params: Record<string, string>): void {
  const callSid = params.CallSid ?? null;
  const callStatus = params.CallStatus ?? null;

  if (!callSid || !callStatus) {
    logDeadLetterEvent(
      "Status callback missing CallSid or CallStatus",
      params,
      log,
    );
    return;
  }

  log.info({ callSid, callStatus }, "Twilio status callback received");

  const session = getCallSessionByCallSid(callSid);
  if (!session) {
    log.warn(
      { callSid, callStatus },
      "Status callback: no call session found for CallSid",
    );
    return;
  }

  const mappedStatus = mapTwilioStatus(callStatus);
  if (!mappedStatus) {
    logDeadLetterEvent(`Unknown Twilio status: ${callStatus}`, params, log);
    return;
  }

  // ── Atomic idempotency claim ────────────────────────────────────
  const timestamp = params.Timestamp ?? null;
  const sequenceNumber = params.SequenceNumber ?? null;
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
    return;
  }

  let eventPersisted = false;
  try {
    const wasTerminal = isTerminalState(session.status);

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

    updateCallSession(session.id, updates, {
      beforeLeaseSync: () => {
        recordCallEvent(session.id, eventType, {
          twilioStatus: callStatus,
          callSid,
        });
        eventPersisted = true;
      },
    });

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

    const finalized = finalizeCallbackClaim(dedupeKey, claimId);
    if (!finalized) {
      log.warn(
        { dedupeKey, claimId, callSid, callStatus },
        "Lost claim during finalization — business writes committed but dedupe ownership was taken by another handler",
      );
    }
  } catch (err) {
    if (eventPersisted) {
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
}

/**
 * Receives call status updates from Twilio (POST with form-urlencoded body).
 * Updates the call session status and records events.
 */
export async function handleStatusCallback(req: Request): Promise<Response> {
  const formBody = new URLSearchParams(await req.text());
  const params = Object.fromEntries(formBody.entries());
  processStatusCallback(params);
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

// ── Transport-agnostic internal route handlers ───────────────────────

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

/**
 * Internal voice-webhook handler for gateway→runtime forwarding.
 * Accepts JSON body `{ params, originalUrl? }` from the gateway.
 */
export async function handleInternalVoiceWebhook({
  body = {},
}: RouteHandlerArgs): Promise<RouteResponse> {
  const { params = {}, originalUrl } = body as {
    params?: Record<string, string>;
    originalUrl?: string;
  };

  // Extract callSessionId from the original URL query string
  let callSessionId: string | null = null;
  if (originalUrl) {
    try {
      callSessionId = new URL(originalUrl).searchParams.get("callSessionId");
    } catch {
      // malformed URL — treat as no callSessionId
    }
  }

  const twiml = await processVoiceWebhook(params, callSessionId);
  return new RouteResponse(twiml, TWIML_HEADERS);
}

/**
 * Internal status-callback handler for gateway→runtime forwarding.
 * Accepts JSON body `{ params }` from the gateway.
 */
export function handleInternalStatusCallback({
  body = {},
}: RouteHandlerArgs): RouteResponse {
  const { params = {} } = body as { params?: Record<string, string> };
  processStatusCallback(params);
  return new RouteResponse(null, {});
}

/**
 * Internal connect-action handler for gateway→runtime forwarding.
 */
export function handleInternalConnectAction(): RouteResponse {
  log.info("ConversationRelay connect-action callback received");
  return new RouteResponse(EMPTY_TWIML, TWIML_HEADERS);
}
