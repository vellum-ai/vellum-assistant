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

function generateTwiML(callSessionId: string, relayUrl: string, welcomeGreeting: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${escapeXml(relayUrl)}?callSessionId=${escapeXml(callSessionId)}"
      welcomeGreeting="${escapeXml(welcomeGreeting)}"
      voice="Google.en-US-Journey-O"
      language="en-US"
      transcriptionProvider="Deepgram"
      ttsProvider="Google"
      interruptible="true"
      dtmfDetection="true"
    />
  </Connect>
</Response>`;
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
    case 'queued':
    case 'ringing':
      return 'ringing';
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
 */
export async function handleVoiceWebhook(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const callSessionId = url.searchParams.get('callSessionId');

  if (!callSessionId) {
    log.warn('Voice webhook called without callSessionId');
    return new Response('Missing callSessionId', { status: 400 });
  }

  const session = getCallSession(callSessionId);
  if (!session) {
    log.warn({ callSessionId }, 'Voice webhook: call session not found');
    return new Response('Call session not found', { status: 404 });
  }

  if (isTerminalState(session.status)) {
    log.warn({ callSessionId, status: session.status }, 'Voice webhook: call session is in terminal state');
    return new Response('Call session is no longer active', { status: 410 });
  }

  // Parse the Twilio POST body to capture CallSid immediately, so status
  // callbacks (keyed by CallSid) can locate this session even if the
  // WebSocket relay hasn't been set up yet.
  const formBody = new URLSearchParams(await req.text());
  const callSid = formBody.get('CallSid');
  if (callSid && callSid !== session.providerCallSid) {
    updateCallSession(callSessionId, { providerCallSid: callSid });
    log.info({ callSessionId, callSid }, 'Stored CallSid from voice webhook');
  }

  const twilioConfig = getTwilioConfig();
  let relayUrl: string;
  try {
    relayUrl = getTwilioRelayUrl(loadConfig());
  } catch {
    // Fallback to legacy resolution when ingress is not configured
    relayUrl = resolveRelayUrl(twilioConfig.wssBaseUrl, twilioConfig.webhookBaseUrl);
  }
  const welcomeGreeting = process.env.CALL_WELCOME_GREETING ?? 'Hello, how can I help you today?';

  const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting);

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

