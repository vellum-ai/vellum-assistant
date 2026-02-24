/**
 * HTTP route handlers for Twilio voice webhooks.
 *
 * - handleVoiceWebhook: initial voice webhook; returns TwiML to connect ConversationRelay
 * - handleStatusCallback: call status updates (ringing, in-progress, completed, etc.)
 * - handleConnectAction: called when the ConversationRelay connection ends
 */

import { getLogger } from '../util/logger.js';
import {
  getCallSession,
  getCallSessionByCallSid,
  updateCallSession,
  recordCallEvent,
  expirePendingQuestions,
  buildCallbackDedupeKey,
  claimCallback,
  releaseCallbackClaim,
  finalizeCallbackClaim,
} from './call-store.js';
import type { CallStatus } from './types.js';
import { logDeadLetterEvent } from './call-recovery.js';
import { isTerminalState } from './call-state-machine.js';
import { getTwilioConfig } from './twilio-config.js';
import { loadConfig } from '../config/loader.js';
import { getTwilioRelayUrl } from '../inbound/public-ingress-urls.js';
import { fireCallCompletionNotifier } from './call-state.js';
import { persistCallCompletionMessage } from './call-conversation-messages.js';
import { resolveVoiceQualityProfile, isVoiceProfileValid } from './voice-quality.js';
import { createInboundVoiceSession } from './call-domain.js';

const log = getLogger('twilio-routes');

// ── Helpers ──────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generateTwiML(
  callSessionId: string,
  relayUrl: string,
  welcomeGreeting: string | null,
  profile: { language: string; transcriptionProvider: string; ttsProvider: string; voice: string },
): string {
  const greetingAttr = welcomeGreeting && welcomeGreeting.trim().length > 0
    ? `\n      welcomeGreeting="${escapeXml(welcomeGreeting.trim())}"`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${escapeXml(relayUrl)}?callSessionId=${escapeXml(callSessionId)}"
${greetingAttr}
      voice="${escapeXml(profile.voice)}"
      language="${escapeXml(profile.language)}"
      transcriptionProvider="${escapeXml(profile.transcriptionProvider)}"
      ttsProvider="${escapeXml(profile.ttsProvider)}"
      interruptible="true"
      dtmfDetection="true"
    />
  </Connect>
</Response>`;
}

export function buildWelcomeGreeting(task: string | null, configuredGreeting?: string): string {
  void task;
  const override = configuredGreeting?.trim();
  if (override) return override;
  // The contextual first opener now comes from the call orchestrator's
  // initial LLM turn. Keep Twilio's relay-level greeting empty by default
  // so we don't speak a deterministic static line first.
  return '';
}

/**
 * Resolve the WebSocket relay URL from Twilio config.
 *
 * Treats wssBaseUrl as present only when it is non-empty after trimming.
 * Falls back to webhookBaseUrl, normalizing the scheme from http(s) to ws(s)
 * and stripping any trailing slash.
 */
export function resolveRelayUrl(wssBaseUrl: string, webhookBaseUrl: string): string {
  const base = wssBaseUrl.trim() || webhookBaseUrl;
  const normalized = base.replace(/\/$/, '').replace(/^http(s?)/, 'ws$1');
  return `${normalized}/v1/calls/relay`;
}

/**
 * Map Twilio call status strings to our internal CallStatus.
 */
function mapTwilioStatus(twilioStatus: string): CallStatus | null {
  switch (twilioStatus) {
    case 'initiated':
    case 'queued':
      return 'initiated';
    case 'ringing':
      return 'ringing';
    case 'answered':
    case 'in-progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'busy':
    case 'no-answer':
    case 'canceled':
      return 'failed';
    default:
      return null;
  }
}

// ── Route handlers ───────────────────────────────────────────────────

/**
 * Receives the initial voice webhook when Twilio connects the call.
 * Returns TwiML XML that tells Twilio to open a ConversationRelay WebSocket.
 *
 * Supports two modes:
 * - **Outbound** (callSessionId present in query): uses the existing session
 * - **Inbound** (callSessionId absent): creates or reuses a session keyed
 *   by the Twilio CallSid. The optional `forwardedAssistantId` is resolved
 *   by the gateway from the "To" phone number.
 */
export async function handleVoiceWebhook(req: Request, forwardedAssistantId?: string): Promise<Response> {
  const url = new URL(req.url);
  const callSessionId = url.searchParams.get('callSessionId');

  // Parse the Twilio POST body to capture CallSid and caller metadata.
  const formBody = new URLSearchParams(await req.text());
  const callSid = formBody.get('CallSid');
  const callerFrom = formBody.get('From') ?? '';
  const callerTo = formBody.get('To') ?? '';

  // ── Inbound mode: no callSessionId in query ─────────────────────
  if (!callSessionId) {
    if (!callSid) {
      log.warn('Inbound voice webhook called without CallSid');
      return new Response('Missing CallSid', { status: 400 });
    }

    log.info({ callSid, from: callerFrom, to: callerTo, assistantId: forwardedAssistantId }, 'Inbound voice webhook — creating/reusing session');

    const { session } = createInboundVoiceSession({
      callSid,
      fromNumber: callerFrom,
      toNumber: callerTo,
      assistantId: forwardedAssistantId,
    });

    return buildVoiceWebhookTwiml(session.id, session.assistantId ?? undefined, session.task);
  }

  // ── Outbound mode: callSessionId is present ─────────────────────
  const session = getCallSession(callSessionId);
  if (!session) {
    log.warn({ callSessionId }, 'Voice webhook: call session not found');
    return new Response('Call session not found', { status: 404 });
  }

  if (isTerminalState(session.status)) {
    log.warn({ callSessionId, status: session.status }, 'Voice webhook: call session is in terminal state');
    return new Response('Call session is no longer active', { status: 410 });
  }

  // Capture CallSid immediately so status callbacks can locate this session
  if (callSid && callSid !== session.providerCallSid) {
    updateCallSession(callSessionId, { providerCallSid: callSid });
    log.info({ callSessionId, callSid }, 'Stored CallSid from voice webhook');
  }

  return buildVoiceWebhookTwiml(callSessionId, session.assistantId ?? undefined, session.task);
}

/**
 * Shared TwiML generation for both inbound and outbound voice webhooks.
 * Resolves voice quality profile, relay URL, and welcome greeting,
 * then returns a Response with the generated TwiML.
 */
function buildVoiceWebhookTwiml(
  callSessionId: string,
  assistantId: string | undefined,
  task: string | null,
): Response {
  let profile = resolveVoiceQualityProfile(loadConfig());

  log.info({ callSessionId, mode: profile.mode, ttsProvider: profile.ttsProvider, voice: profile.voice }, 'Voice quality profile resolved');

  if (profile.validationErrors.length > 0) {
    log.warn({ callSessionId, errors: profile.validationErrors }, 'Voice quality profile has validation warnings');
  }

  // WS-A: Enforce strict fallback semantics — reject invalid profiles when fallback is disabled
  if (!isVoiceProfileValid(profile)) {
    if (!profile.fallbackToStandardOnError) {
      const errorMsg = `Voice quality configuration error: ${profile.validationErrors.join('; ')}`;
      log.error({ callSessionId, errors: profile.validationErrors }, errorMsg);
      return new Response(errorMsg, { status: 500 });
    }
    // Fallback is enabled — profile already resolved to standard; log explicitly
    log.info({ callSessionId }, 'Profile invalid with fallback enabled; proceeding with standard mode');
  }

  // WS-B: Guard elevenlabs_agent until consultation bridge exists.
  // This fires BEFORE any ElevenLabs API calls, blocking the entire mode.
  if (profile.mode === 'elevenlabs_agent') {
    if (!profile.fallbackToStandardOnError) {
      const msg = 'elevenlabs_agent mode is restricted: consultation bridging (waiting_on_user) is not yet supported. Set calls.voice.fallbackToStandardOnError=true to fall back to standard mode.';
      log.error({ callSessionId }, msg);
      return new Response(msg, { status: 501 });
    }
    log.warn({ callSessionId }, 'elevenlabs_agent mode is restricted/experimental — consultation bridging is not yet supported; falling back to standard ConversationRelay TwiML');
    const standardConfig = loadConfig();
    profile = resolveVoiceQualityProfile({
      ...standardConfig,
      calls: {
        ...standardConfig.calls,
        voice: { ...standardConfig.calls.voice, mode: 'twilio_standard' },
      },
    });
  }

  const twilioConfig = getTwilioConfig(assistantId);
  let relayUrl: string;
  try {
    relayUrl = getTwilioRelayUrl(loadConfig());
  } catch {
    // Fallback to legacy resolution when ingress is not configured
    relayUrl = resolveRelayUrl(twilioConfig.wssBaseUrl, twilioConfig.webhookBaseUrl);
  }
  const welcomeGreeting = buildWelcomeGreeting(task, process.env.CALL_WELCOME_GREETING);

  const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, profile);

  log.info({ callSessionId }, 'Returning ConversationRelay TwiML');

  return new Response(twiml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

/**
 * Receives call status updates from Twilio (POST with form-urlencoded body).
 * Updates the call session status and records events.
 */
export async function handleStatusCallback(req: Request): Promise<Response> {
  const formBody = new URLSearchParams(await req.text());
  const callSid = formBody.get('CallSid');
  const callStatus = formBody.get('CallStatus');

  if (!callSid || !callStatus) {
    const rawPayload = Object.fromEntries(formBody.entries());
    logDeadLetterEvent('Status callback missing CallSid or CallStatus', rawPayload, log);
    return new Response(null, { status: 200 });
  }

  log.info({ callSid, callStatus }, 'Twilio status callback received');

  const session = getCallSessionByCallSid(callSid);
  if (!session) {
    log.warn({ callSid, callStatus }, 'Status callback: no call session found for CallSid');
    return new Response(null, { status: 200 });
  }

  const mappedStatus = mapTwilioStatus(callStatus);
  if (!mappedStatus) {
    const rawPayload = Object.fromEntries(formBody.entries());
    logDeadLetterEvent(`Unknown Twilio status: ${callStatus}`, rawPayload, log);
    return new Response(null, { status: 200 });
  }

  // ── Atomic idempotency claim ────────────────────────────────────
  const timestamp = formBody.get('Timestamp');
  const sequenceNumber = formBody.get('SequenceNumber');
  const dedupeKey = buildCallbackDedupeKey(callSid, callStatus, timestamp, sequenceNumber);

  const claimId = claimCallback(dedupeKey, session.id);
  if (!claimId) {
    log.info({ callSid, callStatus, dedupeKey }, 'Duplicate status callback — skipping');
    return new Response(null, { status: 200 });
  }

  try {
    const wasTerminal = isTerminalState(session.status);

    // Build updates
    const updates: Parameters<typeof updateCallSession>[1] = {
      status: mappedStatus,
    };

    if (mappedStatus === 'in_progress' && !session.startedAt) {
      updates.startedAt = Date.now();
    }

    const isTerminal = mappedStatus === 'completed' || mappedStatus === 'failed';
    if (isTerminal) {
      updates.endedAt = Date.now();
    }

    updateCallSession(session.id, updates);

    // Record event
    const eventType = isTerminal
      ? (mappedStatus === 'completed' ? 'call_ended' : 'call_failed')
      : (mappedStatus === 'in_progress' ? 'call_connected' : 'call_started');

    recordCallEvent(session.id, eventType, {
      twilioStatus: callStatus,
      callSid,
    });

    // Expire pending questions on terminal status
    if (isTerminal) {
      expirePendingQuestions(session.id);

      if (!wasTerminal) {
        persistCallCompletionMessage(session.conversationId, session.id);
        fireCallCompletionNotifier(session.conversationId, session.id);
      }
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
        'Lost claim during finalization — business writes committed but dedupe ownership was taken by another handler',
      );
    }
  } catch (err) {
    // Release claim so Twilio retries can reprocess
    releaseCallbackClaim(dedupeKey, claimId);
    throw err;
  }

  return new Response(null, { status: 200 });
}

/**
 * Called when the ConversationRelay connection ends.
 * Returns empty TwiML to acknowledge.
 */
export async function handleConnectAction(_req: Request): Promise<Response> {
  log.info('ConversationRelay connect-action callback received');
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Response/>',
    {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    },
  );
}
