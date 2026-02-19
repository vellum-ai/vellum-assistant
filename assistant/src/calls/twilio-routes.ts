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
} from './call-store.js';
import type { CallStatus } from './types.js';

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

function generateTwiML(callSessionId: string, wssBaseUrl: string, welcomeGreeting: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${wssBaseUrl}/v1/calls/relay?callSessionId=${callSessionId}"
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

  const wssBaseUrl = process.env.WSS_BASE_URL ?? process.env.BASE_URL ?? 'wss://localhost:7821';
  const welcomeGreeting = process.env.CALL_WELCOME_GREETING ?? 'Hello, how can I help you today?';

  const twiml = generateTwiML(callSessionId, wssBaseUrl, welcomeGreeting);

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
    log.warn({ callSid, callStatus }, 'Status callback missing CallSid or CallStatus');
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
    log.warn({ callSid, callStatus }, 'Status callback: unknown Twilio status');
    return new Response(null, { status: 200 });
  }

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
