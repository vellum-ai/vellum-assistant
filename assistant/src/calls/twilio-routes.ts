/**
 * HTTP route handlers for Twilio voice webhooks.
 *
 * - handleVoiceWebhook: initial voice webhook; returns TwiML to connect
 *   ConversationRelay (Twilio-native STT) or Stream (custom media-stream STT)
 * - handleStatusCallback: call status updates (ringing, in-progress, completed, etc.)
 * - handleConnectAction: called when the ConversationRelay connection ends
 *
 * ## STT routing
 *
 * TwiML generation is driven by `services.stt.provider` via
 * {@link resolveTelephonySttRouting}. The resolver returns a discriminated
 * strategy that determines which TwiML path to use:
 *
 * - **`conversation-relay-native`** (deepgram, google-gemini) — emits
 *   `<Connect><ConversationRelay>` with Twilio-native `transcriptionProvider`
 *   and `speechModel` attributes.
 *
 * - **`media-stream-custom`** (openai-whisper) — emits
 *   `<Connect><Stream>` so the daemon receives raw audio and transcribes
 *   server-side.
 */

import { loadConfig } from "../config/loader.js";
import {
  getTwilioMediaStreamUrl,
  getTwilioRelayUrl,
} from "../inbound/public-ingress-urls.js";
import { getProviderEntry } from "../providers/speech-to-text/provider-catalog.js";
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
import { routeSetup } from "./relay-setup-router.js";
import { resolveCallHints } from "./stt-hints.js";
import { resolveTelephonySttRouting } from "./telephony-stt-routing.js";
import type { CallStatus } from "./types.js";
import { resolveVoiceQualityProfile } from "./voice-quality.js";

const log = getLogger("twilio-routes");

/**
 * Sentinel placeholder embedded in TwiML where the relay auth token should go.
 * The gateway replaces this with a real JWT before returning TwiML to Twilio.
 * This keeps the signing key out of the daemon for voice webhook responses.
 */
export const TWILIO_RELAY_TOKEN_PLACEHOLDER = "__VELLUM_RELAY_TOKEN__";

// ── Speech config type ───────────────────────────────────────────────

/**
 * Twilio ConversationRelay speech-to-text attributes.
 *
 * All values are pre-formatted strings ready for direct insertion into
 * TwiML XML attribute values (XML escaping is the caller's responsibility).
 */
export interface TwilioRelaySpeechConfig {
  /** STT provider name (e.g. "Deepgram", "Google"). */
  transcriptionProvider: string;
  /** ASR model identifier, or undefined when the provider default should be used. */
  speechModel: string | undefined;
  /** Comma-separated vocabulary hints for the STT provider, or undefined when no hints are available. */
  hints: string | undefined;
  /** How aggressively the provider detects the start of caller speech. */
  interruptSensitivity: string;
}

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
    ttsProvider: string;
    voice: string;
  },
  speechConfig: TwilioRelaySpeechConfig,
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
      transcriptionProvider="${escapeXml(speechConfig.transcriptionProvider)}"${speechConfig.speechModel ? `\n      speechModel="${escapeXml(speechConfig.speechModel)}"` : ""}
      ttsProvider="${escapeXml(profile.ttsProvider)}"
      interruptible="true"
      dtmfDetection="true"
      interruptSensitivity="${escapeXml(speechConfig.interruptSensitivity)}"${speechConfig.hints ? `\n      hints="${escapeXml(speechConfig.hints)}"` : ""}
    ${relayClose}
  </Connect>
</Response>`;
}

/**
 * Generate `<Connect><Stream>` TwiML for the media-stream STT path.
 *
 * Used when the telephony STT routing resolver selects `media-stream-custom`
 * (e.g. OpenAI Whisper). Twilio opens a WebSocket to `streamUrl` and sends
 * raw audio frames; the daemon transcribes server-side.
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

export function buildWelcomeGreeting(
  task: string | null,
  configuredGreeting?: string,
): string {
  void task;
  const override = configuredGreeting?.trim();
  if (override) return override;
  // The contextual first opener now comes from the call controller's
  // initial LLM turn via the conversation pipeline. Keep Twilio's relay-level
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
function processVoiceWebhook(
  params: Record<string, string>,
  callSessionId: string | null,
): string {
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

    const { session } = createInboundVoiceSession({
      callSid,
      fromNumber: callerFrom,
      toNumber: callerTo,
    });

    return buildVoiceWebhookTwiml(
      session.id,
      {
        task: session.task,
        toNumber: callerTo,
        fromNumber: callerFrom,
        direction: "inbound",
        inviteFriendName: null,
        inviteGuardianName: null,
      },
      session.verificationSessionId,
    );
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

  return buildVoiceWebhookTwiml(
    callSessionId,
    {
      task: session.task,
      toNumber: session.toNumber,
      fromNumber: session.fromNumber,
      direction: "outbound",
      inviteFriendName: session.inviteFriendName,
      inviteGuardianName: session.inviteGuardianName,
    },
    session.verificationSessionId,
  );
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

  const formBody = new URLSearchParams(await req.text());
  const params = Object.fromEntries(formBody.entries());

  try {
    return twimlResponse(processVoiceWebhook(params, callSessionId));
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
 * Resolves the telephony STT routing strategy from `services.stt.provider`
 * and branches:
 *
 * - **`conversation-relay-native`** — emits `<Connect><ConversationRelay>`
 *   TwiML with Twilio-native STT attributes (`transcriptionProvider`,
 *   `speechModel`). Used for deepgram and google-gemini.
 *
 * - **`media-stream-custom`** — emits `<Connect><Stream>` TwiML so the
 *   daemon receives raw audio for server-side transcription. Used for
 *   openai-whisper.
 *
 * When `verificationSessionId` is provided, it is included as a
 * `<Parameter>` in the TwiML for observability and compatibility with
 * the Twilio setup payload. The persisted call session mode is the
 * primary signal for deterministic flow selection in the relay server.
 */
function buildVoiceWebhookTwiml(
  callSessionId: string,
  sessionContext: {
    task: string | null;
    toNumber: string;
    fromNumber: string;
    direction: "inbound" | "outbound";
    inviteFriendName: string | null;
    inviteGuardianName: string | null;
  } | null,
  verificationSessionId?: string | null,
): string {
  const cfg = loadConfig();
  const profile = resolveVoiceQualityProfile(cfg);

  log.info(
    { callSessionId, ttsProvider: profile.ttsProvider, voice: profile.voice },
    "Voice quality profile resolved",
  );

  // Resolve telephony STT strategy from services.stt.provider.
  // The routing resolver handles speech-model defaults internally per provider.
  const routingResult = resolveTelephonySttRouting();

  // Derive Deepgram fallback values from the provider catalog so they stay
  // in sync with the single source of truth. Hardcoded strings are kept only
  // as a final safety net in case the catalog entry is missing.
  const dgEntry = getProviderEntry("deepgram");
  const fallbackProvider =
    dgEntry?.telephonyRouting.twilioNativeMapping?.provider ?? "Deepgram";
  const fallbackModel =
    dgEntry?.telephonyRouting.twilioNativeMapping?.defaultSpeechModel ??
    "nova-3";

  if (routingResult.status === "unknown-provider") {
    log.error(
      {
        callSessionId,
        providerId: routingResult.providerId,
        reason: routingResult.reason,
      },
      "Telephony STT routing failed — unknown provider; falling back to ConversationRelay with Deepgram",
    );
    // Graceful degradation: fall back to Deepgram ConversationRelay so
    // calls don't fail entirely on a misconfigured provider.
    return buildConversationRelayTwiml(
      callSessionId,
      cfg,
      profile,
      sessionContext,
      verificationSessionId,
      { transcriptionProvider: fallbackProvider, speechModel: fallbackModel },
    );
  }

  const { strategy } = routingResult;

  if (strategy.strategy === "conversation-relay-native") {
    return buildConversationRelayTwiml(
      callSessionId,
      cfg,
      profile,
      sessionContext,
      verificationSessionId,
      {
        transcriptionProvider: strategy.transcriptionProvider,
        speechModel: strategy.speechModel,
      },
    );
  }

  // media-stream-custom path — preflight check to reject interactive setup
  // flows that the media-stream transport cannot support. The media-stream
  // server has a defensive fallback for these cases, but catching them here
  // avoids bootstrapping a WebSocket session that will immediately fail.
  const session = getCallSession(callSessionId);
  const from = sessionContext?.fromNumber ?? "";
  const to = sessionContext?.toNumber ?? "";

  const { outcome } = routeSetup({
    callSessionId,
    session: session ?? null,
    from,
    to,
  });

  // The media-stream transport supports normal_call and deny (which speaks
  // a message and tears down). All other outcomes require interactive
  // sub-flows (DTMF entry, name capture, guardian wait) that media-stream
  // cannot perform. Reject these deterministically before stream bootstrap.
  if (outcome.action !== "normal_call" && outcome.action !== "deny") {
    log.warn(
      {
        callSessionId,
        setupAction: outcome.action,
        strategy: "media-stream-custom",
      },
      "Media-stream preflight rejected unsupported interactive setup flow — falling back to ConversationRelay with Deepgram",
    );
    // Fall back to ConversationRelay so the interactive flow can proceed
    // through the relay server which supports it natively.
    return buildConversationRelayTwiml(
      callSessionId,
      cfg,
      profile,
      sessionContext,
      verificationSessionId,
      { transcriptionProvider: fallbackProvider, speechModel: fallbackModel },
    );
  }

  return buildMediaStreamTwiml(callSessionId, cfg, verificationSessionId);
}

/**
 * Build ConversationRelay TwiML for Twilio-native STT providers.
 */
function buildConversationRelayTwiml(
  callSessionId: string,
  cfg: ReturnType<typeof loadConfig>,
  profile: ReturnType<typeof resolveVoiceQualityProfile>,
  sessionContext: {
    task: string | null;
    toNumber: string;
    fromNumber: string;
    direction: "inbound" | "outbound";
    inviteFriendName: string | null;
    inviteGuardianName: string | null;
  } | null,
  verificationSessionId: string | null | undefined,
  sttAttrs: { transcriptionProvider: string; speechModel: string | undefined },
): string {
  const rawHints = resolveCallHints(sessionContext, profile.hints);

  const speechConfig: TwilioRelaySpeechConfig = {
    transcriptionProvider: sttAttrs.transcriptionProvider,
    speechModel: sttAttrs.speechModel,
    hints: rawHints && rawHints.length > 0 ? rawHints : undefined,
    interruptSensitivity: profile.interruptSensitivity,
  };

  const relayUrl = getTwilioRelayUrl(cfg);
  const welcomeGreeting = buildWelcomeGreeting(sessionContext?.task ?? null);
  const relayToken = TWILIO_RELAY_TOKEN_PLACEHOLDER;

  const customParameters: Record<string, string> | undefined =
    verificationSessionId ? { verificationSessionId } : undefined;

  const twiml = generateTwiML(
    callSessionId,
    relayUrl,
    welcomeGreeting,
    profile,
    speechConfig,
    relayToken,
    customParameters,
  );

  log.info(
    {
      callSessionId,
      strategy: "conversation-relay-native",
      transcriptionProvider: sttAttrs.transcriptionProvider,
    },
    "Returning ConversationRelay TwiML",
  );

  return twiml;
}

/**
 * Build Stream TwiML for custom media-stream STT providers.
 */
function buildMediaStreamTwiml(
  callSessionId: string,
  cfg: ReturnType<typeof loadConfig>,
  verificationSessionId: string | null | undefined,
): string {
  const streamUrl = getTwilioMediaStreamUrl(cfg);
  const relayToken = TWILIO_RELAY_TOKEN_PLACEHOLDER;

  const customParameters: Record<string, string> | undefined =
    verificationSessionId ? { verificationSessionId } : undefined;

  const twiml = generateStreamTwiML(
    callSessionId,
    streamUrl,
    relayToken,
    customParameters,
  );

  log.info(
    { callSessionId, strategy: "media-stream-custom" },
    "Returning Stream TwiML",
  );

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
export function handleInternalVoiceWebhook({
  body = {},
}: RouteHandlerArgs): RouteResponse {
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

  const twiml = processVoiceWebhook(params, callSessionId);
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
